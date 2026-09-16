export function titleFromPrompt(prompt: string): string {
  let cleaned = prompt.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
  cleaned = cleaned.replace(/^plan\s+(?:a|an|the)\s+/i, "");
  cleaned = cleaned.replace(
    /\s+for\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:people|friends|guests)\b.*$/i,
    "",
  );
  cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  if (cleaned.length <= 64) return cleaned;
  return `${cleaned.slice(0, 61).trimEnd()}…`;
}
