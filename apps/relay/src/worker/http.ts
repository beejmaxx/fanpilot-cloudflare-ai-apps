import { z, type ZodType } from "zod";

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export async function parseJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let body: unknown;
  try { body = await request.json(); } catch { throw new HttpError(400, "Request body must be valid JSON"); }
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, "Request body is invalid", z.flattenError(result.error));
  return result.data;
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly details?: unknown) { super(message); }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return json({ error: error.message, details: error.details }, { status: error.status });
  console.error(error);
  return json({ error: "Unexpected server error" }, { status: 500 });
}
