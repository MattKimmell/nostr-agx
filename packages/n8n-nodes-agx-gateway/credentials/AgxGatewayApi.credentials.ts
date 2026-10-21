import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from "n8n-workflow";

/**
 * An agx gateway: the URL it is published at and one of its API keys.
 *
 * The gateway holds the agent's Nostr secret key and talks to relays, so n8n
 * never sees the key: what is stored here can be revoked on the gateway with
 * `agx gateway key revoke` without changing the agent's identity.
 */
export class AgxGatewayApi implements ICredentialType {
	name = "agxGatewayApi";

	displayName = "AGX Gateway API";

	icon: Icon = {
		light: "file:../icons/agx.svg",
		dark: "file:../icons/agx.dark.svg",
	};

	documentationUrl =
		"https://github.com/ellavox-ai/nostr-agx/tree/main/packages/n8n-nodes-agx-gateway#credentials";

	properties: INodeProperties[] = [
		{
			displayName: "Gateway URL",
			name: "url",
			type: "string",
			required: true,
			default: "",
			placeholder: "https://agx.example.com",
			description:
				"Where `agx gateway` is published. Use https:// for anything but a gateway on the same machine as n8n.",
		},
		{
			displayName: "API Key",
			name: "apiKey",
			type: "string",
			typeOptions: { password: true },
			required: true,
			default: "",
			placeholder: "agxg_…",
			description: "A key from `agx gateway key new`, run where the gateway runs",
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: "generic",
		properties: {
			headers: {
				Authorization: "=Bearer {{$credentials.apiKey}}",
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.url.replace(/\\/+$/, "")}}',
			url: "/v1/identity",
		},
		rules: [
			{
				type: "responseCode",
				properties: {
					value: 401,
					message: "The gateway refused this API key. Create one with `agx gateway key new`.",
				},
			},
		],
	};
}
