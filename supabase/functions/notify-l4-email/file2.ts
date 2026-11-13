// @ts-nocheck
const EVENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function response(status, body, corsHeaders) {
    return new Response(body === null ? null : JSON.stringify(body), {
        status,
        headers: {
            ...corsHeaders,
            ...(body === null ? {} : { 'Content-Type': 'application/json; charset=utf-8' })
        }
    });
}

export function createL4EmailHandler({ allowedOrigins = [], fromAddress, resolveAuthorizedL4Event, sendEmail }) {
    const originSet = new Set(allowedOrigins.map(value => String(value).trim()).filter(Boolean));

    return async function handleL4Email(request) {
        const requestOrigin = request.headers.get('origin') || '';
        const corsHeaders = {
            'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Vary': 'Origin'
        };
        const originAllowed = Boolean(requestOrigin && originSet.has(requestOrigin));
        if (originAllowed) corsHeaders['Access-Control-Allow-Origin'] = requestOrigin;

        if (request.method === 'OPTIONS') {
            return response(originAllowed ? 204 : 403, null, corsHeaders);
        }
        if (!originAllowed) return response(403, { error: 'origin_not_allowed' }, corsHeaders);
        if (request.method !== 'POST') return response(405, { error: 'method_not_allowed' }, corsHeaders);
        if (!request.headers.get('authorization')) return response(401, { error: 'unauthorized' }, corsHeaders);
        if (typeof resolveAuthorizedL4Event !== 'function' || typeof sendEmail !== 'function' || !fromAddress) {
            return response(503, { error: 'email_service_not_configured' }, corsHeaders);
        }

        let body;
        try {
            body = await request.json();
        } catch (_) {
            return response(400, { error: 'invalid_json' }, corsHeaders);
        }
        const eventId = typeof body?.eventId === 'string' ? body.eventId.trim() : '';
        if (!EVENT_ID_PATTERN.test(eventId)) return response(400, { error: 'invalid_event_id' }, corsHeaders);

        try {
            const resolved = await resolveAuthorizedL4Event(request, eventId);
            if (!resolved || !resolved.event || !resolved.user?.email) {
                return response(404, { error: 'l4_event_not_found' }, corsHeaders);
            }
            if (resolved.event.id !== eventId) return response(404, { error: 'l4_event_not_found' }, corsHeaders);
            if (resolved.event.event_type !== 'L4') return response(422, { error: 'event_not_l4' }, corsHeaders);

            const text = [
                '照護系統記錄到一筆新的 L4 警報。',
                '請登入照護者頁面查看警示並確認個案狀況。',
                '為保護個案隱私，郵件未附姓名、時間或事件細節。'
            ].join('\n');

            await sendEmail({
                to: resolved.user.email,
                from: fromAddress,
                subject: 'L4 進食安全提醒',
                text,
                idempotencyKey: eventId
            });
            return response(202, { ok: true, eventId }, corsHeaders);
        } catch (error) {
            console.warn('[L4 email] Notification delivery failed:', error?.message || 'unknown error');
            return response(502, { error: 'email_delivery_failed' }, corsHeaders);
        }
    };
}

export function createResendSender({ apiKey, fetchImpl = fetch } = {}) {
    return async function sendL4Email({ from, to, subject, text, idempotencyKey } = {}) {
        if (!apiKey) throw new Error('RESEND_API_KEY is not configured.');
        if (!from || !to || !subject || !text || !idempotencyKey) {
            throw new TypeError('Complete email fields and an idempotency key are required.');
        }
        const response = await fetchImpl('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Idempotency-Key': idempotencyKey
            },
            body: JSON.stringify({ from, to: [to], subject, text })
        });
        if (!response.ok) throw new Error(`Resend request failed (${response.status}).`);
        return response.json();
    };
}

export function createL4EventResolver({ supabaseUrl, publishableKey, createClient }) {
    return async function resolveAuthorizedL4Event(request, eventId) {
        const authorization = request.headers.get('authorization');
        if (!supabaseUrl || !publishableKey || !authorization || typeof createClient !== 'function') return null;

        let supabase;
        try {
            supabase = createClient(supabaseUrl, publishableKey, {
                auth: { autoRefreshToken: false, persistSession: false },
                global: { headers: { Authorization: authorization } }
            });
        } catch (_) {
            return null;
        }

        const { data: userData, error: userError } = await supabase.auth.getUser();
        const user = userData?.user;
        if (userError || !user?.id || !user.email) return null;

        const { data: event, error: eventError } = await supabase
            .from('anomaly_logs')
            .select('id,event_type,triggered_at,session_id,owner_id')
            .eq('id', eventId)
            .maybeSingle();
        if (eventError || !event || event.id !== eventId || event.owner_id !== user.id) return null;

        const { data: session, error: sessionError } = await supabase
            .from('meal_sessions')
            .select('patient_id,owner_id')
            .eq('id', event.session_id)
            .maybeSingle();
        if (sessionError || !session || session.owner_id !== user.id) return null;

        const { data: patient, error: patientError } = await supabase
            .from('patient_profiles')
            .select('owner_id')
            .eq('id', session.patient_id)
            .maybeSingle();
        if (patientError || !patient || patient.owner_id !== user.id) return null;

        return {
            user: { id: user.id, email: user.email },
            event: {
                id: event.id,
                event_type: event.event_type,
                triggered_at: event.triggered_at
            }
        };
    };
}
