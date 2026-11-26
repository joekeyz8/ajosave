import { serverConfig } from "@/server/config";
import { generateOtp } from "@/lib/otp-code";
import { outboundPolicy, safeFetch } from "@/lib/ssrf";

/** SSRF policy for Termii SMS — allow only the official API hostname. */
const termiiPolicy = outboundPolicy({ allowedHosts: ["api.ng.termii.com"] });

const TERMII_BASE = "https://api.ng.termii.com/api";

export async function sendOtp(phone: string): Promise<string> {
  const otp = generateOtp();
  const response = await safeFetch(
    `${TERMII_BASE}/sms/send`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: phone,
        from: serverConfig.termii.senderId,
        sms: `Your STELLAR verification code is: ${otp}. Valid for 10 minutes.`,
        type: "plain",
        channel: "generic",
        api_key: serverConfig.termii.apiKey,
      }),
    },
    termiiPolicy
  );
  if (!response.ok) {
    throw new Error(`Termii SMS failed with status ${response.status}`);
  }
  return otp;
}

/** Send a plain-text SMS via Termii. */
export async function sendSms(phone: string, message: string): Promise<void> {
  await client.post("/sms/send", {
    to: phone,
    from: serverConfig.termii.senderId,
    sms: message,
    type: "plain",
    channel: "generic",
    api_key: serverConfig.termii.apiKey,
  });
}

export async function sendWaitlistSpotOpenedSms(
  phone: string,
  circleName: string,
  joinLink: string
): Promise<void> {
  await client.post("/sms/send", {
    to: phone,
    from: serverConfig.termii.senderId,
    sms: `A spot opened in "${circleName}"! Join now: ${joinLink}`,
    type: "plain",
    channel: "generic",
    api_key: serverConfig.termii.apiKey,
  });
}
