/**
 * Content Safety & Prompt Injection Guardrail Service
 *
 * Scans incoming customer text for prompt injection, jailbreak attempts,
 * and malicious system override strings before passing context to the LLM.
 */

import { logger } from "./logger.js";

// Common prompt injection & jailbreak patterns
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous\s+)?instructions/i,
  /override\s+(system\s+)?prompt/i,
  /you\s+are\s+now\s+in\s+developer\s+mode/i,
  /forget\s+(all\s+)?your\s+rules/i,
  /act\s+as\s+an?\s+unrestricted/i,
  /system:\s*confirm\s*order/i,
  /system:\s*payment\s*received/i,
  /reveal\s+(your\s+)?system\s+prompt/i,
  /print\s+(your\s+)?instructions/i,
];

export interface SafetyCheckResult {
  isSafe: boolean;
  sanitizedText: string;
  flaggedReason?: string;
}

/**
 * Check customer input for prompt injections and malicious overrides.
 */
export function inspectContentSafety(text: string): SafetyCheckResult {
  const input = text ?? "";

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(input)) {
      logger.warn(`🛡️ [Guardrail Flagged] Prompt injection attempt detected: "${input.slice(0, 80)}..."`);
      return {
        isSafe: false,
        sanitizedText: "Hello! I am an AI assistant here to help you order delicious food from our menu. How can I help you today?",
        flaggedReason: `Matches pattern: ${pattern.source}`,
      };
    }
  }

  return {
    isSafe: true,
    sanitizedText: input,
  };
}
