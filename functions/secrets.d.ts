// Pages secrets are configured remotely and cannot be declared in a Pages wrangler.jsonc file.
// This declaration augments Wrangler's generated Env type with those encrypted bindings.
interface Env {
  AUTH_PASSWORD: string
  AUTH_SESSION_SECRET: string
}
