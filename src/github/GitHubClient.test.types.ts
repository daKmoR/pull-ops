export interface OctokitCall {
  name: string;
  params: Record<string, unknown>;
  query?: string;
}

export interface ExistingLabel {
  name: string;
  color: string;
  description: string | null;
}
