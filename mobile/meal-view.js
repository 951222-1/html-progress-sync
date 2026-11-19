(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.MealView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    function createMealView({ document: doc, container, endButton, statusElement }) {
        let generation = 0;
        let wasNative = false;
        const setStatus = text => { if (statusElement) statusElement.textContent = text; };
        const fullscreenChanged = () => {
            const owner = doc.fullscreenElement || doc.webkitFullscreenElement;
            if (owner === container) {
                wasNative = true;
            } else if (wasNative) {
                wasNative = false;
                container.classList.remove('meal-view-active');
                doc.body.classList.remove('meal-view-open');
                setStatus('已離開全螢幕，用餐仍在進行');
            }
        };
        doc.addEventListener('fullscreenchange', fullscreenChanged);
        doc.addEventListener('webkitfullscreenchange', fullscreenChanged);
        async function leaveNative() {
            const owner = doc.fullscreenElement || doc.webkitFullscreenElement;
            const exit = doc.exitFullscreen || doc.webkitExitFullscreen;
            if (owner === container && exit) {
                try { await exit.call(doc); } catch (_) { /* The browser may already have left. */ }
            }
        }
        return {
            enter() {
                const enteringGeneration = ++generation;
                container.classList.add('meal-view-active');
                doc.body.classList.add('meal-view-open');
                endButton.hidden = false;
                setStatus('正在準備用餐畫面…');
                const fallback = () => {
                    if (enteringGeneration === generation) setStatus('沉浸用餐模式（瀏覽器未允許系統全螢幕）');
                };
                const request = container.requestFullscreen || container.webkitRequestFullscreen;
                if (!request) { fallback(); return Promise.resolve(); }
                try {
                    // Must run synchronously in the original click, before auth/media awaits.
                    return Promise.resolve(request.call(container, { navigationUI: 'hide' }))
                        .then(async () => {
                            if (enteringGeneration !== generation) { await leaveNative(); return; }
                            setStatus('用餐中');
                        }, fallback);
                } catch (_) {
                    fallback();
                    return Promise.resolve();
                }
            },
            async exit() {
                generation++;
                wasNative = false;
                container.classList.remove('meal-view-active');
                doc.body.classList.remove('meal-view-open');
                endButton.hidden = true;
                await leaveNative();
            }
        };
    }
    return { createMealView };
});
