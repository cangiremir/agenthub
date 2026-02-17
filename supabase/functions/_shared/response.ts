export const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init
  });

export const badRequest = (message: string) => json({ error: message }, { status: 400 });
export const unauthorized = (message = "Unauthorized") => json({ error: message }, { status: 401 });
export const forbidden = (message = "Forbidden") => json({ error: message }, { status: 403 });
