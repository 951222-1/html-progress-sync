/* Public endpoint address only; never place tunnel or Supabase credentials here. */
(function (root) {
    'use strict';
    root.LOCAL_RECORDING_TUNNEL_CONFIG = Object.freeze({
        apiOrigin: 'https://unholy-blunt-arise.ngrok-free.dev'
    });
})(typeof window !== 'undefined' ? window : globalThis);
