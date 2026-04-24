// Селекторы, которые Яндекс Диск использует для фото в слайдере
const IMAGE_SELECTORS = [
    'img.p-view__image',
    'img[class*="viewer"]',
    'img[class*="slider"]',
    'img[class*="photo"]',
    '.resources-viewer__photo img',
    '.p-viewer img',
];

const exifCache = new Map();
const urlCache = new Map(); // кэш оригинальных URL файлов
let currentPrefetchPath = null;

function findSliderImage() {
    for (const selector of IMAGE_SELECTORS) {
        const img = document.querySelector(selector);
        if (img && img.src && img.naturalWidth > 200) {
            return img;
        }
    }
    // Запасной вариант: найти самое большое изображение на странице (не иконки)
    const allImages = Array.from(document.querySelectorAll('img'));
    return allImages.find(img =>
        img.src &&
        img.naturalWidth > 500 &&
        !img.src.startsWith('data:') &&
        img.src.includes('yandex')
    ) || null;
}

function getSk() {
    const scripts = document.querySelectorAll('script:not([src])');
    for (const script of scripts) {
        const match = script.textContent.match(/"sk"\s*:\s*"([^"]+)"/);
        if (match) return match[1];
    }
    return null;
}

async function getOriginalUrl() {
    const params = new URLSearchParams(location.search);
    const filePath = params.get('idDialog');
    if (!filePath) return null;

    const sk = getSk();
    if (!sk) {
        console.error('[EXIF Viewer] sk токен не найден');
        return null;
    }

    return new Promise((resolve) => {
        const requestId = Math.random().toString(36).slice(2);

        const handler = (event) => {
            if (event.data?.type !== 'EXIF_URL_RESULT' || event.data.requestId !== requestId) return;
            window.removeEventListener('message', handler);
            clearTimeout(timer);
            if (event.data.error || !event.data.file) {
                resolve(null);
            } else {
                const file = event.data.file;
                resolve(file.startsWith('//') ? 'https:' + file : file);
            }
        };

        const timer = setTimeout(() => {
            window.removeEventListener('message', handler);
            resolve(null);
        }, 2000);

        window.addEventListener('message', handler);
        window.postMessage({ type: 'EXIF_GET_URL', sk, path: filePath, requestId }, '*');
    });
}

async function showExifData(fallbackUrl) {
    const params = new URLSearchParams(location.search);
    const filePath = params.get('idDialog');

    if (filePath && exifCache.has(filePath)) {
        // Данные уже загружены в кэш! Отдаем моментально.
        removeOverlay();
        const data = exifCache.get(filePath);
        if (data && data.error) {
            displayOverlay(null, data.error);
        } else if (data) {
            displayOverlay(data);
        } else {
            displayOverlay(null, 'EXIF данные не найдены');
        }
        return;
    }

    removeOverlay();
    showLoadingOverlay(filePath);

    // Запускаем предзагрузку, если она почему-то еще не началась
    if (filePath && currentPrefetchPath !== filePath) {
        currentPrefetchPath = filePath;
        prefetchExif(filePath, fallbackUrl);
    }
}

async function prefetchExif(filePath, fallbackUrl) {
    try {
        let originalUrl;

        // Используем кэш URL, если уже знаем его
        if (urlCache.has(filePath)) {
            originalUrl = urlCache.get(filePath);
        } else {
            originalUrl = await getOriginalUrl();
            if (originalUrl) urlCache.set(filePath, originalUrl);
        }

        const imageUrl = originalUrl || fallbackUrl;
        if (!imageUrl) throw new Error('Не удалось получить URL файла');

        // Range-запрос: берем только первые 128 КБ — EXIF всегда в них
        const response = await fetch(imageUrl, {
            headers: { 'Range': 'bytes=0-131071' }
        });
        if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status}`);

        // Если сервер ответил 206 — мы уже получили ровно 128 КБ и соединение закрыто.
        // Если 200 — сервер не поддерживает Range, читаем потоком до 128 КБ
        let blob;
        if (response.status === 206) {
            blob = await response.blob();
        } else if (response.body) {
            const reader = response.body.getReader();
            const chunks = [];
            let receivedLength = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                receivedLength += value.length;
                if (receivedLength >= 131072) {
                    reader.cancel().catch(() => { });
                    break;
                }
            }
            blob = new Blob(chunks, { type: response.headers.get('content-type') || 'image/jpeg' });
        } else {
            blob = await response.blob();
        }

        const file = new File([blob], 'photo.jpg', { type: blob.type });

        EXIF.getData(file, function () {
            const tags = EXIF.getAllTags(this);
            const hasTags = Object.keys(tags).length > 0;
            exifCache.set(filePath, hasTags ? tags : null);

            // Если оверлей уже открыт и ждет именно этот файл - обновляем его!
            const overlay = document.getElementById('exif-info-overlay');
            if (overlay && overlay.dataset.waitingFor === filePath) {
                removeOverlay();
                if (hasTags) {
                    displayOverlay(tags);
                } else {
                    displayOverlay(null, 'EXIF данные не найдены');
                }
            }
        });
    } catch (error) {
        console.error('[EXIF Viewer] Ошибка загрузки фото:', error);
        exifCache.set(filePath, { error: error.message });
        const overlay = document.getElementById('exif-info-overlay');
        if (overlay && overlay.dataset.waitingFor === filePath) {
            removeOverlay();
            displayOverlay(null, error.message);
        }
    }
}

function showLoadingOverlay(filePath) {
    let overlay = document.getElementById('exif-info-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'exif-info-overlay';
        document.body.appendChild(overlay);
    }
    overlay.dataset.waitingFor = filePath || '';
    overlay.innerHTML = `<h3>EXIF Info</h3><p>Загрузка...</p>`;
}

function removeOverlay() {
    const existing = document.getElementById('exif-info-overlay');
    if (existing) existing.remove();
}

function displayOverlay(data, errorMsg) {
    let overlay = document.getElementById('exif-info-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'exif-info-overlay';
        document.body.appendChild(overlay);
    }

    if (!data) {
        overlay.innerHTML = `
            <h3>EXIF Info</h3>
            <p>${errorMsg ? 'Ошибка: ' + errorMsg : 'EXIF данные не найдены'}</p>
            <button id="exif-close-btn">Закрыть</button>
        `;
        document.getElementById('exif-close-btn').onclick = removeOverlay;
        return;
    }

    const fields = [
        ['Камера', data.Make ? `${data.Make} ${data.Model || ''}`.trim() : null],
        ['Объектив', data.LensModel],
        ['Дата съёмки', data.DateTimeOriginal],
        ['ISO', data.ISOSpeedRatings],
        ['Выдержка', data.ExposureTime ? formatExposure(data.ExposureTime) : null],
        ['Диафрагма', data.FNumber ? `f/${data.FNumber}` : null],
        ['Фокусное расстояние', data.FocalLength ? `${data.FocalLength} мм` : null],
        ['Вспышка', data.Flash !== undefined ? formatFlash(data.Flash) : null],
        ['GPS', formatGPS(data)],
    ];

    const rows = fields
        .filter(([, v]) => v)
        .map(([k, v]) => `<p><b>${k}:</b> ${v}</p>`)
        .join('');

    const hasGPS = data.GPSLatitude && data.GPSLongitude;
    let lat = null;
    let lon = null;
    if (hasGPS) {
        lat = convertDMS(data.GPSLatitude, data.GPSLatitudeRef);
        lon = convertDMS(data.GPSLongitude, data.GPSLongitudeRef);
    }

    overlay.innerHTML = `
        ${rows || '<p>Данные пусты</p>'}
        ${hasGPS ? '<div id="exif-map" style="height: 200px; width: 100%; margin-top: 10px; border-radius: 8px; z-index: 10000;"></div>' : ''}
    `;

    // Создаем кнопку-крестик в углу
    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = `
        <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none">
            <path d="M20.7457 3.32851C20.3552 2.93798 19.722 2.93798 19.3315 3.32851L12.0371 10.6229L4.74275 3.32851C4.35223 2.93798 3.71906 2.93798 3.32854 3.32851C2.93801 3.71903 2.93801 4.3522 3.32854 4.74272L10.6229 12.0371L3.32856 19.3314C2.93803 19.722 2.93803 20.3551 3.32856 20.7457C3.71908 21.1362 4.35225 21.1362 4.74277 20.7457L12.0371 13.4513L19.3315 20.7457C19.722 21.1362 20.3552 21.1362 20.7457 20.7457C21.1362 20.3551 21.1362 19.722 20.7457 19.3315L13.4513 12.0371L20.7457 4.74272C21.1362 4.3522 21.1362 3.71903 20.7457 3.32851Z" fill="white" stroke="white" stroke-width="1.0" stroke-linejoin="round"/>
        </svg>
    `;
    closeBtn.id = 'exif-close-btn';
    closeBtn.style.cssText = `
        position: absolute !important;
        top: 4px !important;
        right: 4px !important;
        width: 28px !important;
        height: 28px !important;
        background: transparent !important;
        border: none !important;
        border-radius: 6px !important;
        cursor: pointer !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        padding: 4px !important;
        margin: 0 !important;
        transition: background 0.2s;
        z-index: 100000 !important;
    `;

    closeBtn.onmouseenter = () => closeBtn.style.backgroundColor = 'rgba(255, 255, 255, 0.15)';
    closeBtn.onmouseleave = () => closeBtn.style.backgroundColor = 'transparent';
    closeBtn.onclick = removeOverlay;

    overlay.appendChild(closeBtn);

    if (hasGPS) {
        renderMicroMap('exif-map', lat, lon, 15);
    }
}

const MAP_LAYERS = [
    { name: 'HOT', url: 'https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', icon: '🏥' },
    { name: 'Вело', url: 'https://a.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', icon: '🚲' },
    { name: 'OSM', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', icon: '🌍' },
    { name: 'Dark', url: 'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', icon: '🌙' },
    { name: 'Voyager', url: 'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', icon: '✈️' },
    { name: 'OSM DE', url: 'https://a.tile.openstreetmap.de/tiles/osmde/{z}/{x}/{y}.png', icon: '🇩🇪' },
    { name: 'ArcGIS', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', icon: '🗺️' }
];

/**
 * Продвинутый Микро-движок карты (OSM + Zoom + Drag + Layers)
 */
function renderMicroMap(containerId, initialLat, initialLon, initialZoom = 15) {
    const container = document.getElementById(containerId);
    if (!container) return;

    let currentLat = initialLat;
    let currentLon = initialLon;
    let currentZoom = initialZoom;
    let currentLayerIndex = 0;

    // Состояние перетаскивания
    let isDragging = false;
    let startX, startY;
    let mapLeft = 0, mapTop = 0;

    // Сначала загружаем сохраненный слой из памяти браузера
    chrome.storage.local.get(['lastLayerIndex'], (result) => {
        if (result.lastLayerIndex !== undefined) {
            currentLayerIndex = result.lastLayerIndex;
        }
        redraw(); // Рисуем только после того, как узнали какой слой нужен
    });

    function redraw() {
        const layer = MAP_LAYERS[currentLayerIndex];

        const n = Math.pow(2, currentZoom);
        const x = ((currentLon + 180) / 360) * n;
        const latRad = currentLat * Math.PI / 180;
        const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;

        const tileX = Math.floor(x);
        const tileY = Math.floor(y);
        const offsetX = (x - tileX) * 256;
        const offsetY = (y - tileY) * 256;

        container.style.position = 'relative';
        container.style.overflow = 'hidden';
        container.style.backgroundColor = '#ddd';
        container.style.cursor = 'grab';
        container.innerHTML = '';

        const mapCanvas = document.createElement('div');
        mapCanvas.id = 'map-canvas';
        mapCanvas.style.position = 'absolute';
        mapCanvas.style.width = '1280px';
        mapCanvas.style.height = '1280px';

        const containerWidth = container.offsetWidth || 300;
        const containerHeight = container.offsetHeight || 200;

        mapLeft = (containerWidth / 2 - (offsetX + 512)) + 0;
        mapTop = (containerHeight / 2 - (offsetY + 512)) + 12;

        mapCanvas.style.left = `${mapLeft}px`;
        mapCanvas.style.top = `${mapTop}px`;

        for (let i = -2; i <= 2; i++) {
            for (let j = -2; j <= 2; j++) {
                const img = document.createElement('img');
                img.src = layer.url
                    .replace('{z}', currentZoom)
                    .replace('{x}', tileX + i)
                    .replace('{y}', tileY + j);

                img.style.position = 'absolute';
                img.style.left = `${(i + 2) * 256}px`;
                img.style.top = `${(j + 2) * 256}px`;
                img.style.width = '256px';
                img.style.height = '256px';
                img.style.userSelect = 'none';
                img.draggable = false;
                mapCanvas.appendChild(img);
            }
        }

        const marker = document.createElement('div');
        marker.innerHTML = `
            <svg width="40" height="40" viewBox="0 0 24 24" fill="#7f7f7fff" stroke="#3b3b3bff" stroke-width="0">
                <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
                
                <circle cx="12" cy="9" r="5" fill="#a6a6a6ff" />

                <g transform="translate(7.2, 4.2) scale(0.0185)">
                    <path fill="#3b3b3bff" d="M289.544,1.991l-74.577,129.132h267.532C446.312,65.22,373.904,11.416,289.544,1.991z M52.053,102.727l74.542,129.149
                        L260.36,0.19C185.189-1.428,102.395,34.375,52.053,102.727z M20.544,358.77l149.118,0.018L35.896,127.102
                        C-3.088,191.388-13.483,281.002,20.544,358.77z M226.525,514.077l74.577-129.132H33.571
                        C69.757,450.849,142.166,504.652,226.525,514.077z M464.017,413.342l-74.542-129.149L255.709,515.878
                        C330.88,517.496,413.675,481.693,464.017,413.342z M495.525,157.299l-149.118-0.018l133.766,231.686
                        C519.157,324.681,529.553,235.066,495.525,157.299z"/>
                </g>
            </svg>
        `;
        marker.style.position = 'absolute';
        marker.style.left = `${offsetX + 512}px`;
        marker.style.top = `${offsetY + 512}px`;
        marker.style.transform = 'translate(-50%, -100%)';
        marker.style.zIndex = '1000';
        marker.style.pointerEvents = 'none';

        mapCanvas.appendChild(marker);
        container.appendChild(mapCanvas);

        // 4. Кнопки управления
        const zoomControls = document.createElement('div');
        zoomControls.style.cssText = `
            position: absolute !important;
            top: 0px !important;
            left: 8px !important;
            margin: 0 !important;
            padding: 0 !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 0px !important;
            z-index: 20000 !important;
        `;

        const layerControls = document.createElement('div');
        layerControls.style.position = 'absolute';
        layerControls.style.bottom = '11px';
        layerControls.style.left = '8px';
        layerControls.style.zIndex = '2000';

        const btnStyle = `
            width: 28px; height: 28px; 
            background: white; border: none; 
            border-radius: 5px; cursor: pointer; 
            font-size: 20px; font-weight: bold; 
            display: flex; align-items: center; justify-content: center;
            box-shadow: 0 2px 5px rgba(0,0,0,0.2);
            color: #5c5c5cff; transition: background 0.2s;
        `;

        const btnPlus = document.createElement('button');
        btnPlus.innerHTML = '+';
        btnPlus.style.cssText = btnStyle;
        btnPlus.onclick = (e) => { e.stopPropagation(); if (currentZoom < 19) { currentZoom++; redraw(); } };

        const btnMinus = document.createElement('button');
        btnMinus.innerHTML = '−';
        btnMinus.style.cssText = btnStyle;
        btnMinus.onclick = (e) => { e.stopPropagation(); if (currentZoom > 1) { currentZoom--; redraw(); } };

        const btnLayer = document.createElement('button');
        btnLayer.innerHTML = layer.icon;
        btnLayer.title = `Слой: ${layer.name}`;
        btnLayer.style.cssText = btnStyle + ' font-size: 16px;';
        btnLayer.onclick = (e) => {
            e.stopPropagation();
            currentLayerIndex = (currentLayerIndex + 1) % MAP_LAYERS.length;
            // Сохраняем выбор в память расширения
            chrome.storage.local.set({ lastLayerIndex: currentLayerIndex });
            redraw();
        };

        zoomControls.appendChild(btnPlus);
        zoomControls.appendChild(btnMinus);
        layerControls.appendChild(btnLayer);

        container.appendChild(zoomControls);
        container.appendChild(layerControls);

        // Логика Drag-and-Drop
        container.onmousedown = (e) => {
            isDragging = true;
            container.style.cursor = 'grabbing';
            startX = e.clientX - mapLeft;
            startY = e.clientY - mapTop;
        };

        window.onmousemove = (e) => {
            if (!isDragging) return;
            mapLeft = e.clientX - startX;
            mapTop = e.clientY - startY;
            mapCanvas.style.left = `${mapLeft}px`;
            mapCanvas.style.top = `${mapTop}px`;
        };

        window.onmouseup = () => { if (isDragging) { isDragging = false; container.style.cursor = 'grab'; } };
    }
}

function formatExposure(val) {
    if (val >= 1) return `${val} с`;
    return `1/${Math.round(1 / val)} с`;
}

function formatFlash(val) {
    return (val & 1) ? 'Сработала' : 'Не сработала';
}

function formatGPS(data) {
    if (!data.GPSLatitude || !data.GPSLongitude) return null;
    const lat = convertDMS(data.GPSLatitude, data.GPSLatitudeRef);
    const lon = convertDMS(data.GPSLongitude, data.GPSLongitudeRef);
    return `<a href="https://maps.google.com/?q=${lat},${lon}" target="_blank">${lat.toFixed(5)}, ${lon.toFixed(5)}</a>`;
}

function convertDMS(dms, ref) {
    const [d, m, s] = dms;
    let dec = d + m / 60 + s / 3600;
    if (ref === 'S' || ref === 'W') dec = -dec;
    return dec;
}



// Слушаем SPA-навигацию: при открытии/закрытии слайдера меняется URL
let lastUrl = location.href;

function onUrlChange(force = false) {
    const current = location.href;
    if (!force && current === lastUrl) return;
    lastUrl = current;

    const hasDialog = current.includes('idDialog=');
    if (!hasDialog) {
        removeOverlay();
    } else {
        const idDialog = new URLSearchParams(location.search).get('idDialog');
        if (idDialog && currentPrefetchPath !== idDialog) {
            currentPrefetchPath = idDialog;

            // Запускаем предзагрузку немедленно, не ждём 300мс!
            // getOriginalUrl() не нуждается в img, только фаллбэк нуждается.
            prefetchExif(idDialog, null);

            // Параллельно через немного 400мс дополняем fallback через img.src
            // (img может ещё грузиться)
            setTimeout(() => {
                if (exifCache.has(idDialog)) return; // уже есть
                const img = findSliderImage();
                if (img && img.src) prefetchExif(idDialog, img.src);
            }, 400);

            // Хак: Яндекс иногда автоматически фокусирует кнопку "Закрыть",
            // из-за чего появляется неприятная желтая рамка. Снимаем фокус!
            setTimeout(() => {
                const active = document.activeElement;
                if (active && active.tagName === 'BUTTON') {
                    const t = (active.title || active.getAttribute('aria-label') || '').toLowerCase();
                    if (t.includes('закрыть') || t.includes('close')) {
                        active.blur();
                    }
                }
            }, 150);
        }
    }
}

// Перехватываем pushState/replaceState
const origPush = history.pushState.bind(history);
const origReplace = history.replaceState.bind(history);

history.pushState = function (...args) {
    origPush(...args);
    onUrlChange();
};
history.replaceState = function (...args) {
    origReplace(...args);
    onUrlChange();
};

window.addEventListener('popstate', onUrlChange);

let syncRAF = null;
let cachedPanel = null;

// Добавляем кнопку "Показать EXIF" когда слайдер открыт
function injectExifButton() {
    const hasDialog = location.href.includes('idDialog=');
    if (!hasDialog) {
        cachedPanel = null; // сброс кэша
        return;
    }

    let btn = document.getElementById('exif-show-btn');
    if (!btn) {
        btn = document.createElement('button');
        btn.id = 'exif-show-btn';
        btn.textContent = 'EXIF';
        btn.title = 'Показать EXIF данные фотографии';
        btn.onclick = () => {
            const img = findSliderImage();
            if (img) {
                showExifData(img.src);
            } else {
                alert('Не удалось найти изображение на странице.');
            }
        };
        // Кнопка ВСЕГДА живет в body, чтобы не ломать React Яндекса
        document.body.appendChild(btn);
    } else if (btn.parentElement !== document.body) {
        document.body.appendChild(btn);
    }

    // Запускаем бесконечный цикл синхронизации позиции и прозрачности с панелью Яндекса
    if (!syncRAF) {
        const sync = () => {
            syncRAF = requestAnimationFrame(sync);

            const btn = document.getElementById('exif-show-btn');
            if (!btn) return;

            if (!location.href.includes('idDialog=')) {
                btn.style.display = 'none';
                return;
            }

            // Ищем панель (с кэшированием)
            if (!cachedPanel || !document.body.contains(cachedPanel)) {
                cachedPanel = findTopPanel();
            }
            const panel = cachedPanel;

            if (panel) {
                const rect = panel.getBoundingClientRect();
                const style = window.getComputedStyle(panel);

                // Если панель уехала вверх или стала невидимой (Яндекс спрятал UI)
                if (rect.top < -10 || style.opacity === '0' || style.visibility === 'hidden' || style.display === 'none') {
                    btn.style.opacity = '0';
                    btn.style.pointerEvents = 'none';
                } else {
                    btn.style.display = 'block';
                    btn.style.opacity = style.opacity;
                    btn.style.pointerEvents = 'auto';

                    // Выравниваем по центру панели динамически (кадры анимации)
                    const centerY = Math.round(rect.top + rect.height / 2);
                    btn.style.setProperty('top', centerY + 'px', 'important');
                    btn.style.setProperty('transform', 'translateY(-50%)', 'important');
                    btn.classList.add('exif-btn-in-panel');
                }
            } else {
                // Запасной вариант - панель еще не появилась, показываем внизу
                btn.style.display = 'block';
                btn.style.opacity = '1';
                btn.style.pointerEvents = 'auto';
                btn.classList.remove('exif-btn-in-panel');
                btn.style.removeProperty('top');
                btn.style.removeProperty('transform');
            }
        };
        syncRAF = requestAnimationFrame(sync);
    }
}

function findTopPanel() {
    // Проверяем, что элемент действительно находится вверху экрана
    const isTopPanel = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.top < 100 && rect.width > window.innerWidth * 0.4;
    };

    const selectors = [
        '.slider__header',
        '.p-view__header',
        '.p-viewer__header',
        '.resources-viewer__header',
        '[class*="slider"] [class*="header"]',
        '[class*="viewer"] [class*="header"]',
        '[class*="Viewer"] [class*="Header"]'
    ];
    for (const s of selectors) {
        const el = document.querySelector(s);
        if (el && isTopPanel(el)) return el;
    }

    // Эвристика: ищем по кнопкам закрытия/скачивания,
    // но только если сама кнопка находится вверху экрана (не в боковой панели)
    const buttons = document.querySelectorAll('button');
    for (const b of buttons) {
        const bRect = b.getBoundingClientRect();
        if (bRect.top > 100) continue; // игнорируем кнопки, которые не в верхней части

        const t = (b.title || '').toLowerCase();
        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
        if (t.includes('закрыть') || t.includes('скачать') || t.includes('close') || t.includes('download') ||
            aria.includes('закрыть') || aria.includes('скачать')) {
            let parent = b.parentElement;
            for (let i = 0; i < 6; i++) {
                if (!parent || parent === document.body) break;
                if (isTopPanel(parent)) return parent;
                parent = parent.parentElement;
            }
        }
    }
    return null;
}

// Следим за изменениями DOM для появления слайдера
const observer = new MutationObserver(() => {
    onUrlChange();
    if (location.href.includes('idDialog=')) {
        injectExifButton();
    } else {
        const btn = document.getElementById('exif-show-btn');
        if (btn) btn.remove();
        removeOverlay();
    }
});

observer.observe(document.body, { childList: true, subtree: true });

// Запуск при начальной загрузке с dialog в URL
if (location.href.includes('idDialog=')) {
    onUrlChange(true);
    injectExifButton();
}
