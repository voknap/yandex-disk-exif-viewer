window.addEventListener('message', async (event) => {
    if (event.source !== window || event.data?.type !== 'EXIF_GET_URL') return;

    const { sk, path, requestId } = event.data;

    try {
        const res = await fetch('https://disk.yandex.ru/models-v2?m=mpfs/url', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({
                sk,
                connection_id: Date.now().toString(),
                apiMethod: 'mpfs/url',
                requestParams: { path },
            }),
        });
        const data = await res.json();
        window.postMessage({ type: 'EXIF_URL_RESULT', requestId, file: data.file ?? null }, '*');
    } catch (e) {
        window.postMessage({ type: 'EXIF_URL_RESULT', requestId, error: e.message }, '*');
    }
});
