/**
 * Vercel serverless entry point for GET /api/oanda-rest/*.
 * See api/_lib/handler.mjs — this file only exists to give Vercel a
 * concrete, statically-named route prefix to bind the catch-all under
 * (Vercel's own dynamic-route examples always nest a [...slug] file under a
 * real folder rather than putting it directly at the api/ root).
 */
export { default, config } from '../_lib/handler.mjs';
