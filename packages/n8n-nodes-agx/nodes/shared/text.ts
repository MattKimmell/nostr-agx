/**
 * A text parameter as a string. n8n types a parameter by its field, but an
 * expression — or an AI Agent filling a tool parameter — can hand over a
 * number, a boolean or an object instead, and calling `.trim()` on that throws
 * a TypeError the user cannot act on. A ticket number used as a Conversation
 * ID should just work. Absent is "".
 */
export function asText(value: unknown): string {
	if (value === undefined || value === null) {
		return "";
	}
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "object") {
		return JSON.stringify(value);
	}
	return String(value);
}
