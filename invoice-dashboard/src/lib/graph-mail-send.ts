/**
 * Shared Microsoft Graph API email sender.
 *
 * Uses the same OAuth2 client credentials as the existing pull-mailbox and
 * fbo-fee-request senders. Sends from a specified mailbox (default: operations@).
 */

const DEFAULT_MAILBOX = "operations@baker-aviation.com";

async function getGraphToken(): Promise<string> {
  const tenant = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  if (!tenant || !clientId || !clientSecret) {
    throw new Error("MS Graph credentials not configured (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET)");
  }

  const res = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
        scope: "https://graph.microsoft.com/.default",
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph token failed: ${res.status} ${text}`);
  }
  return (await res.json()).access_token;
}

export interface SendMailOptions {
  /** Recipient email address */
  to: string;
  /** Email subject */
  subject: string;
  /** HTML body */
  html: string;
  /** Optional plain text body */
  plainText?: string;
  /** CC recipients */
  cc?: string[];
  /** Mailbox to send from (defaults to operations@baker-aviation.com) */
  from?: string;
  /** Save to sent items folder (default: true) */
  saveToSentItems?: boolean;
}

export interface SendMailResult {
  success: boolean;
  error?: string;
}

/**
 * Send an email via Microsoft Graph API.
 *
 * Uses the /sendMail endpoint which only needs the Mail.Send permission.
 * Does not return a message ID — Graph's sendMail is fire-and-forget.
 */
export async function sendGraphMail(opts: SendMailOptions): Promise<SendMailResult> {
  const mailbox = opts.from ?? DEFAULT_MAILBOX;

  let token: string;
  try {
    token = await getGraphToken();
  } catch (err) {
    return {
      success: false,
      error: `Auth failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const message: Record<string, unknown> = {
    subject: opts.subject,
    body: {
      contentType: "HTML",
      content: opts.html,
    },
    toRecipients: [{ emailAddress: { address: opts.to } }],
  };

  if (opts.cc?.length) {
    message.ccRecipients = opts.cc.map((addr) => ({
      emailAddress: { address: addr },
    }));
  }

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/sendMail`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message,
        saveToSentItems: opts.saveToSentItems ?? true,
      }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    return {
      success: false,
      error: `Graph sendMail failed: ${res.status} ${text.slice(0, 300)}`,
    };
  }

  return { success: true };
}

/**
 * Read recent messages from a mailbox. Useful for polling for replies.
 */
export async function listMailboxMessages(opts: {
  mailbox: string;
  lookbackMinutes?: number;
  maxMessages?: number;
  filter?: string;
}): Promise<Array<{
  id: string;
  subject: string;
  receivedDateTime: string;
  from: string;
  bodyPreview: string;
  body?: string;
}>> {
  const token = await getGraphToken();
  const lookback = opts.lookbackMinutes ?? 120;
  const maxMsg = opts.maxMessages ?? 50;
  const since = new Date(Date.now() - lookback * 60 * 1000).toISOString();

  let filterStr = `receivedDateTime ge ${since}`;
  if (opts.filter) filterStr += ` and ${opts.filter}`;

  const url = new URL(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(opts.mailbox)}/messages`,
  );
  url.searchParams.set("$top", String(Math.min(maxMsg, 100)));
  url.searchParams.set("$orderby", "receivedDateTime desc");
  url.searchParams.set("$filter", filterStr);
  url.searchParams.set("$select", "id,subject,receivedDateTime,from,bodyPreview,body");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph list messages failed: ${res.status} ${text}`);
  }

  const json = await res.json();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (json.value ?? []).map((m: any) => ({
    id: m.id,
    subject: m.subject ?? "",
    receivedDateTime: m.receivedDateTime,
    from: m.from?.emailAddress?.address ?? "",
    bodyPreview: m.bodyPreview ?? "",
    body: m.body?.content ?? "",
  }));
}
