import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	JsonObject,
} from "n8n-workflow";
import { NodeApiError } from "n8n-workflow";

/**
 * Calls to an agx gateway, with the credential's API key. The gateway answers
 * JSON, and an error as `{ error: { code, message, description? } }`, which
 * becomes a `NodeApiError` carrying that message and remedy.
 */

export type GatewayContext = IExecuteFunctions | IHookFunctions;

export interface GatewayResponse {
	statusCode: number;
	body: unknown;
}

interface GatewayErrorBody {
	error?: { code?: string; message?: string; description?: string };
}

export async function gatewayUrl(ctx: GatewayContext): Promise<string> {
	const credentials = await ctx.getCredentials("agxGatewayApi");
	return String(credentials.url ?? "").replace(/\/+$/, "");
}

/** One API call. Answers every HTTP status; only a gateway that cannot be
 * reached at all throws. */
export async function gatewayRequest(
	ctx: GatewayContext,
	method: IHttpRequestMethods,
	path: string,
	options: { body?: IDataObject; qs?: IDataObject; timeoutMs?: number; itemIndex?: number } = {},
): Promise<GatewayResponse> {
	const base = await gatewayUrl(ctx);
	const request: IHttpRequestOptions = {
		method,
		url: `${base}${path}`,
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		timeout: options.timeoutMs ?? 60_000,
		...(options.body ? { body: options.body } : {}),
		...(options.qs ? { qs: options.qs } : {}),
	};
	try {
		const response = (await ctx.helpers.httpRequestWithAuthentication.call(
			ctx,
			"agxGatewayApi",
			request,
		)) as { statusCode: number; body: unknown };
		return { statusCode: response.statusCode, body: response.body };
	} catch (error) {
		throw new NodeApiError(ctx.getNode(), error as JsonObject, {
			message: `Could not reach the agx gateway at ${base}`,
			description:
				"Check that `agx gateway` is running and published at this URL, and that n8n can reach it.",
			itemIndex: options.itemIndex,
		});
	}
}

/** The error a failed call reports, with the gateway's own message. */
export function gatewayError(
	ctx: GatewayContext,
	response: GatewayResponse,
	itemIndex?: number,
): NodeApiError {
	const reported = (response.body as GatewayErrorBody | null)?.error;
	return new NodeApiError(ctx.getNode(), (response.body ?? {}) as JsonObject, {
		message: reported?.message ?? `The agx gateway answered HTTP ${response.statusCode}`,
		description:
			reported?.description ??
			(response.statusCode === 401
				? "The credential's API key was refused. Create one with `agx gateway key new`."
				: undefined),
		httpCode: String(response.statusCode),
		itemIndex,
	});
}

export function succeeded(response: GatewayResponse): boolean {
	return response.statusCode >= 200 && response.statusCode < 300;
}
