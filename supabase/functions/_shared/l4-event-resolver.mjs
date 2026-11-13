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
