#!/usr/bin/env node
/**
 * Script: parse-conditions.mts
 *
 * Lee preguntas desde JSON o TSV, parsea las condiciones (&& / ||) y las
 * traduce usando condiciones-logicas.tsv. Genera un JSON con section, question
 * y condition (partes + etiquetas) listo para convertir en columnas.
 *
 * Uso:
 *   pnpm exec tsx scripts/questionnaire-conditions/parse-conditions.mts
 *   pnpm exec tsx scripts/questionnaire-conditions/parse-conditions.mts path/to/preguntas.json
 *   pnpm exec tsx scripts/questionnaire-conditions/parse-conditions.mts path/to/preguntas.tsv
 */

import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, ".");

type QuestionInput = {
	section?: string;
	question?: string;
	condition?: string;
	answer?: string;
	[key: string]: unknown;
};
type ConditionPart = { type: "condition"; raw: string; label: string } | { type: "op"; value: "AND" | "OR" };
/** Fila para Excel: columna 1 = section, columna 2 = question, columna 3 = conditions */
type ExcelRow = {
	section: string;
	question: string;
	conditions: string;
};

const CONDICIONES_FILE = "condiciones-logicas.tsv";
const REPORTE_FILE = "reporte-condiciones.json";

/** Formato por línea: "Descripción: condición." */
function loadCondicionesLogicas(root: string): Map<string, string> {
	const path = resolve(root, CONDICIONES_FILE);
	const text = readFileSync(path, "utf-8");
	const lines = text.split(/\r?\n/).filter((l) => l.trim());
	const map = new Map<string, string>();
	for (const line of lines) {
		const colonIndex = line.indexOf(": ");
		if (colonIndex === -1) continue;
		const desc = line.slice(0, colonIndex).trim();
		let cond = line.slice(colonIndex + 2).trim();
		if (cond.endsWith(".")) cond = cond.slice(0, -1).trim();
		if (cond) map.set(normalizeCondition(cond), desc);
	}
	return map;
}

/**
 * Quita paréntesis externos que envuelven toda la expresión (el primer "("
 * cierra con el último ")"), para que "(X)" y "X" normalicen igual.
 */
function stripOuterParens(s: string): string {
	let t = s.trim();
	while (t.startsWith("(") && t.endsWith(")")) {
		let depth = 0;
		let match = false;
		for (let i = 0; i < t.length; i++) {
			if (t[i] === "(") depth++;
			else if (t[i] === ")") {
				depth--;
				if (depth === 0) {
					match = i === t.length - 1;
					break;
				}
			}
		}
		if (!match) break;
		t = t.slice(1, -1).trim();
	}
	return t;
}

function normalizeCondition(c: string): string {
	let out = c
		.trim()
		.replace(/\s+/g, " ")
		.replace(/\s*&&\s*/g, " AND ")
		.replace(/\s*\|\|\s*/g, " OR ")
		.replace(/\s*==\s*/, "==")
		.replace(/\s*!=\s*/, "!=")
		.replace(/\s*<\s*/, " < ")
		.replace(/\s*>\s*/, " > ");
	return stripOuterParens(out);
}

/** Elimina comentarios de línea `//...` para no parsear lógica comentada. */
function stripLineComments(raw: string): string {
	return raw
		.split(/\r?\n/)
		.map((line) => line.replace(/\/\/.*$/, ""))
		.join("\n")
		.trim();
}

/**
 * Limpia bloques tipo script para dejar solo expresiones de condición.
 * Ejemplo: remueve líneas como `result = ...`, `result === true`, `if (...)`, llaves, etc.
 */
function sanitizeConditionRaw(raw: string): string {
	const noComments = stripLineComments(raw);
	if (!noComments) return "";
	const kept = noComments
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean)
		.filter((line) => {
			if (/^(if|else|return|let|const|var)\b/i.test(line)) return false;
			if (/^[{}]+$/.test(line)) return false;
			if (/^result\s*=/.test(line)) return false;
			if (/^result\s*===?/.test(line)) return false;
			return true;
		});
	return kept.join(" ").trim();
}

/**
 * Parte la condición solo por && y || que estén al nivel superior (depth 0),
 * respetando paréntesis, para que cada subexpresión pueda matchear el TSV.
 */
function parseConditionParts(condition: string): ConditionPart[] {
	const raw = sanitizeConditionRaw(condition ?? "");
	if (!raw) return [];
	return splitAtTopLevel(raw);
}

function splitAtTopLevel(raw: string): ConditionPart[] {
	const s = stripOuterParens(raw);
	if (!s) return [];

	let depth = 0;
	const positions: { index: number; length: number; op: "AND" | "OR" }[] = [];
	for (let i = 0; i < s.length; i++) {
		if (s[i] === "(") {
			depth++;
			continue;
		}
		if (s[i] === ")") {
			depth--;
			continue;
		}
		if (depth !== 0) continue;
		if (s.slice(i, i + 2) === "&&") {
			positions.push({ index: i, length: 2, op: "AND" });
			i++;
			continue;
		}
		if (s.slice(i, i + 2) === "||") {
			positions.push({ index: i, length: 2, op: "OR" });
			i++;
			continue;
		}
	}

	if (positions.length === 0) {
		return [{ type: "condition", raw: s, label: "" }];
	}

	const result: ConditionPart[] = [];
	let start = 0;
	for (const pos of positions) {
		const segment = s.slice(start, pos.index).trim();
		if (segment) result.push(...splitAtTopLevel(segment));
		result.push({ type: "op", value: pos.op });
		start = pos.index + pos.length;
	}
	const tail = s.slice(start).trim();
	if (tail) result.push(...splitAtTopLevel(tail));
	return result;
}

/**
 * Determina si una sub-condición NO debe aparecer en el reporte.
 *
 * Casos a omitir:
 * - !this['_isInCorrectNameOrBirthday']
 * - (!this['birthday'] || this['_isInCorrectNameOrBirthday'])
 * - this['privacy']=='yes'
 * - Cualquier condición basada en flags lógicos this['logic...']
 * - Condiciones tipo indexOf(...) == -1 (filtro técnico de la respuesta anterior)
 */
function shouldDropCondition(raw: string): boolean {
	const normalized = normalizeCondition(raw);
	// Quitar paréntesis de envoltura
	const bare = normalized.replace(/^\(+/, "").replace(/\)+$/, "");

	// 1) Condición técnica de nombre/fecha de nacimiento
	if (bare === "!this['_isInCorrectNameOrBirthday']") return true;
	if (bare === "this['_isInCorrectNameOrBirthday']") return true;
	if (bare === "!this['birthday']") return true;
	if (bare === "!this['birthday'] OR this['_isInCorrectNameOrBirthday']") return true;
	if (/^this\['privacy'\]={2,3}['"]yes['"]$/i.test(bare)) return true;

	// 2) Flags lógicos como this['logicBHGroupTherapyConsent'], this['logicCopay'], etc.
	if (bare.includes("this['logic")) return true;
	if (/\bresult\b/.test(bare)) return true;
	if (/^(if|else|return)\b/i.test(bare)) return true;

	// 3) Condiciones de tipo indexOf(...) == -1 (ej. person-type self)
	if (/indexOf\(.*\)==-1$/.test(bare)) return true;

	return false;
}

/**
 * Filtra las partes de condición que no deben mostrarse y re-compone
 * los operadores AND/OR para no dejar operadores colgando.
 */
function filterConditionParts(parts: ConditionPart[]): ConditionPart[] {
	const result: ConditionPart[] = [];
	let pendingOp: ConditionPart | null = null;

	for (const p of parts) {
		if (p.type === "op") {
			pendingOp = p;
			continue;
		}

		// p.type === "condition"
		if (shouldDropCondition(p.raw)) {
			// Se omite la condición y el operador previo
			continue;
		}

		// Solo añadimos el operador si ya hay algo en result
		if (result.length > 0 && pendingOp) {
			result.push(pendingOp);
		}
		result.push(p);
		pendingOp = null;
	}

	return result;
}

function resolveLabels(
	parts: ConditionPart[],
	condMap: Map<string, string>,
	newConditions: Set<string>,
): void {
	for (const p of parts) {
		if (p.type === "condition") {
			const key = normalizeCondition(p.raw);
			const label = condMap.get(key);
			if (label !== undefined) {
				p.label = label;
			} else {
				p.label = normalizeCondition(p.raw);
				newConditions.add(p.label);
			}
		}
	}
}

const ALWAYS_ON = "Always On";
const FALSE_NOT_WORKING = "false: not working";

/**
 * Condición inválida por "false" al inicio:
 * - false
 * - false && ...
 * - (false) && ...
 */
function isFalseGateCondition(raw: string): boolean {
	const cleaned = sanitizeConditionRaw(raw ?? "");
	return /^\(*\s*false\s*\)*(\s*&{1,2}|\s*$)/i.test(cleaned);
}

/**
 * Construye la columna conditions: sin condición → "Always On";
 * si varias partes matchean la misma etiqueta (ej. dos "First visit") no repetir, una basta.
 */
function conditionColumn(parts: ConditionPart[]): string {
	if (parts.length === 0) return ALWAYS_ON;
	const tokens = parts
		.map((p) => (p.type === "op" ? p.value : p.label || p.raw))
		.filter(Boolean);
	// Quitar etiquetas duplicadas: si la siguiente etiqueta es igual a la última, no añadir op ni etiqueta
	const deduped: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		const isOp = t === "AND" || t === "OR";
		if (isOp) {
			deduped.push(t);
		} else {
			const lastLabel = deduped.length > 0 ? findLastLabel(deduped) : null;
			if (lastLabel === t) {
				if (deduped.at(-1) === "AND" || deduped.at(-1) === "OR") deduped.pop();
			} else {
				deduped.push(t);
			}
		}
	}
	return deduped.join(" ").trim() || ALWAYS_ON;
}

function findLastLabel(tokens: string[]): string | null {
	for (let i = tokens.length - 1; i >= 0; i--) {
		if (tokens[i] !== "AND" && tokens[i] !== "OR") return tokens[i];
	}
	return null;
}

function loadQuestions(inputPath: string): QuestionInput[] {
	const content = readFileSync(inputPath, "utf-8").trim();

	// TSV: answer \t question \t section \t condition \t subtext \t values
	if (inputPath.endsWith(".tsv") || content.startsWith("answer\t") || !content.trimStart().startsWith("[")) {
		const lines = content.split(/\r?\n/);
		const header = (lines[0] ?? "").split("\t").map((h) => h.trim().toLowerCase());
		const questionIdx = header.indexOf("question");
		const sectionIdx = header.indexOf("section");
		const conditionIdx = header.indexOf("condition");
		const rows: QuestionInput[] = [];
		for (let i = 1; i < lines.length; i++) {
			const cols = lines[i].split("\t");
			rows.push({
				section: sectionIdx >= 0 ? (cols[sectionIdx] ?? "").trim() : "",
				question: questionIdx >= 0 ? (cols[questionIdx] ?? "").trim() : "",
				condition: conditionIdx >= 0 ? (cols[conditionIdx] ?? "").trim() : "",
			});
		}
		return rows;
	}

	// JSON array
	const data = JSON.parse(content) as QuestionInput | QuestionInput[];
	return Array.isArray(data) ? data : [data];
}

function appendNewConditions(root: string, newConditions: Set<string>): void {
	if (newConditions.size === 0) return;
	const path = resolve(root, CONDICIONES_FILE);
	const existing = readFileSync(path, "utf-8");
	const existingNormalized = new Set<string>();
	for (const line of existing.split(/\r?\n/)) {
		const colonIndex = line.indexOf(": ");
		if (colonIndex === -1) continue;
		const cond = line.slice(colonIndex + 2).trim().replace(/\.$/, "").trim();
		if (cond) existingNormalized.add(normalizeCondition(cond));
	}
	const toAppend: string[] = [];
	for (const raw of newConditions) {
		if (existingNormalized.has(normalizeCondition(raw))) continue;
		toAppend.push(`${raw}: ${raw}.`);
	}
	if (toAppend.length > 0) {
		appendFileSync(path, "\n" + toAppend.join("\n") + "\n", "utf-8");
	}
}

function main(): void {
	const inputPath = process.argv[2]
		? resolve(process.cwd(), process.argv[2])
		: resolve(ROOT, "preguntas-section-input.json");

	const condMap = loadCondicionesLogicas(ROOT);
	const questions = loadQuestions(inputPath);
	const newConditions = new Set<string>();

	const SECTION_SKIP = "Time Logic";

	// Agrupar por section (orden de primera aparición), excluyendo Time Logic
	const sectionOrder: string[] = [];
	const bySection = new Map<string, QuestionInput[]>();
	for (const q of questions) {
		const section = (q.section ?? "").trim();
		if (section === SECTION_SKIP) continue;
		if (!bySection.has(section)) sectionOrder.push(section);
		const list = bySection.get(section) ?? [];
		list.push(q);
		bySection.set(section, list);
	}

	// Una fila por section: primera pregunta sin "false" al inicio; si todas tienen false → "false: not working"
	const excelRows: ExcelRow[] = [];
	for (const section of sectionOrder) {
		if (!section) continue;
		const sectionQuestions = bySection.get(section) ?? [];
		let chosenQuestion: QuestionInput | undefined;
		let chosenConditions = ALWAYS_ON;
		let fallbackQuestion: QuestionInput | undefined;
		let fallbackConditions = ALWAYS_ON;
		let hasNonFalse = false;

		for (const q of sectionQuestions) {
			const conditionRaw = (q.condition ?? "").trim();
			if (isFalseGateCondition(conditionRaw)) continue;
			hasNonFalse = true;
			const parts = filterConditionParts(parseConditionParts(conditionRaw));
			resolveLabels(parts, condMap, newConditions);
			const currentConditions = conditionColumn(parts);
			if (!fallbackQuestion) {
				fallbackQuestion = q;
				fallbackConditions = currentConditions;
			}
			// Preferir la primera pregunta con condición real (no Always On)
			if (currentConditions !== ALWAYS_ON) {
				chosenQuestion = q;
				chosenConditions = currentConditions;
				break;
			}
		}

		const question = chosenQuestion ?? fallbackQuestion ?? sectionQuestions[0];
		const questionText = (question?.question ?? "").trim();
		const conditions = hasNonFalse
			? (chosenQuestion ? chosenConditions : fallbackConditions)
			: FALSE_NOT_WORKING;
		excelRows.push({
			section,
			question: questionText,
			conditions,
		});
	}

	appendNewConditions(ROOT, newConditions);
	// Guardar JSON listo para Excel: fila 1 = headers (section, question, conditions), fila 2+ = datos
	const reportPath = resolve(ROOT, REPORTE_FILE);
	writeFileSync(reportPath, JSON.stringify(excelRows, null, 2) + "\n", "utf-8");
	console.log(`Reporte generado en: ${reportPath}`);
}

main();
