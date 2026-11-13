// @ts-nocheck
import { createClient } from 'npm:@supabase/supabase-js@2';
import { createL4EventResolver, createL4EmailHandler, createResendSender } from './file2.ts';

function getPublishableKey() {
    const rawKeys = Deno.env.get('SUPABASE_PUBLISHABLE_KEYS');
    if (rawKeys) {
        try {
            const parsed = JSON.parse(rawKeys);
            if (typeof parsed === 'string' && parsed.startsWith('sb_publishable_')) return parsed;
            if (parsed && typeof parsed === 'object') {
                if (typeof parsed.default === 'string' && parsed.default.startsWith('sb_publishable_')) return parsed.default;
                const publishable = Object.values(parsed).find(value =>
                    typeof value === 'string' && value.startsWith('sb_publishable_')
                );
                if (publishable) return publishable;
            }
        } catch (_) {
            // Fall through to the legacy environment variable.
        }
    }
    return Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || '';
}

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const publishableKey = getPublishableKey();
const resendApiKey = Deno.env.get('RESEND_API_KEY') || '';
const configuredFromAddress = Deno.env.get('RESEND_FROM_EMAIL') || '';
const allowedOrigins = (Deno.env.get('L4_EMAIL_ALLOWED_ORIGINS')
    || 'https://951222-1.github.io,http://127.0.0.1:8110,http://localhost:8110')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

const sendEmail = createResendSender({ apiKey: resendApiKey });
const resolveAuthorizedL4Event = createL4EventResolver({ supabaseUrl, publishableKey, createClient });
const handler = createL4EmailHandler({
    allowedOrigins,
    fromAddress: resendApiKey && configuredFromAddress ? configuredFromAddress : '',
    resolveAuthorizedL4Event,
    sendEmail
});

Deno.serve(handler);
