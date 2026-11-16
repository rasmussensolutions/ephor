export const DEFAULT_AI_MODEL = "~anthropic/claude-sonnet-latest";
export interface AiStatus {
  provider: "openrouter";
  connected: boolean;
  verified: boolean;
  verifiedAt: number | null;
  model: string;
}
export interface BuildDiagnosis {
  text: string;
  model: string;
  createdAt: number;
}
