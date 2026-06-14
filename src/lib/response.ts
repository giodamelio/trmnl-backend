// Generic HTTP helpers shared across feeds.

export function json(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
}

export function errorResponse(error: string, status: number, detail?: string): Response {
  return Response.json(detail ? { error, detail } : { error }, { status });
}
