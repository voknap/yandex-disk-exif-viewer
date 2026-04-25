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
let currentMapHeight = 150; // Глобальная переменная для высоты карты
let currentOverlayWidth = 250; // Глобальная переменная для ширины оверлея

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

        EXIF.getData(file, async function () {
            const tags = EXIF.getAllTags(this);
            const hasTags = Object.keys(tags).length > 0;

            if (hasTags && tags.GPSLatitude && tags.GPSLongitude) {
                try {
                    const lat = convertDMS(tags.GPSLatitude, tags.GPSLatitudeRef);
                    const lon = convertDMS(tags.GPSLongitude, tags.GPSLongitudeRef);
                    // Фоновое геокодирование
                    const address = await getReverseGeocode(lat, lon);
                    tags._cachedAddress = address;
                } catch (e) {
                    console.warn('[EXIF Viewer] Ошибка фонового геокодирования:', e);
                }
            }

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

    // Только динамические параметры, остальное возьмет из styles.css
    overlay.style.width = `${currentOverlayWidth}px`;
    overlay.style.display = 'block';

    // Генерируем 4 скелетных блока
    let skeletonHtml = `
        <div style="position: absolute; top: 7px; right: 7px; width: 28px; height: 28px; background: rgba(255,255,255,0.05); border-radius: 7px;"></div>
    `;

    for (let i = 0; i < 4; i++) {
        skeletonHtml += `
            <div class="skeleton-block">
                <div class="skeleton-icon"></div>
                <div class="skeleton-lines">
                    <div class="skeleton-line"></div>
                    <div class="skeleton-line short"></div>
                </div>
            </div>
        `;
    }

    // Добавляем блок под карту
    skeletonHtml += `<div class="skeleton-map" style="height: ${currentMapHeight}px; margin-top: 4px;"></div>`;

    overlay.innerHTML = skeletonHtml;
}

function removeOverlay() {
    const existing = document.getElementById('exif-info-overlay');
    if (existing) existing.remove();
}

/**
 * Создает универсальную кнопку закрытия для оверлея
 */
function createCloseButton(parent) {
    // Если кнопка уже есть, не дублируем
    if (parent.querySelector('#exif-close-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'exif-close-btn';
    btn.innerHTML = `
        <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none">
            <path d="M20.7457 3.32851C20.3552 2.93798 19.722 2.93798 19.3315 3.32851L12.0371 10.6229L4.74275 3.32851C4.35223 2.93798 3.71906 2.93798 3.32854 3.32851C2.93801 3.71903 2.93801 4.3522 3.32854 4.74272L10.6229 12.0371L3.32856 19.3314C2.93803 19.722 2.93803 20.3551 3.32856 20.7457C3.71908 21.1362 4.35225 21.1362 4.74277 20.7457L12.0371 13.4513L19.3315 20.7457C19.722 21.1362 20.3552 21.1362 20.7457 20.7457C21.1362 20.3551 21.1362 19.722 20.7457 19.3315L13.4513 12.0371L20.7457 4.74272C21.1362 4.3522 21.1362 3.71903 20.7457 3.32851Z" fill="#f0f0f0" stroke="#f0f0f0" stroke-width="0.9" stroke-linejoin="round"/>
        </svg>
    `;
    btn.style.cssText = `
        position: absolute !important;
        top: 7px !important;
        right: 7px !important;
        width: 28px !important;
        height: 28px !important;
        background: transparent !important;
        border: none !important;
        border-radius: 7px !important;
        cursor: pointer !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        padding: 4px !important;
        margin: 0 !important;
        transition: background 0.2s;
        z-index: 100000 !important;
    `;
    btn.onmouseenter = () => { btn.style.backgroundColor = 'rgba(255, 255, 255, 0.15)'; };
    btn.onmouseleave = () => { btn.style.backgroundColor = 'transparent'; };
    btn.onclick = (e) => { e.stopPropagation(); removeOverlay(); };
    parent.appendChild(btn);
}

/**
 * Парсит дату из EXIF (YYYY:MM:DD HH:MM:SS) в красивый формат
 */
function parseExifDate(dateStr) {
    if (!dateStr) return null;
    const parts = dateStr.split(' ');
    if (parts.length < 2) return null;
    const dateParts = parts[0].split(':');
    const timeParts = parts[1].split(':');
    const date = new Date(dateParts[0], dateParts[1] - 1, dateParts[2], timeParts[0], timeParts[1], timeParts[2]);

    if (isNaN(date.getTime())) return null;

    const mainDate = date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    const dayOfWeek = date.toLocaleDateString('ru-RU', { weekday: 'short' });
    const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

    let tz = '';
    const tzMatch = dateStr.match(/[+-]\d{2}:\d{2}$/);
    if (tzMatch) tz = ` GMT${tzMatch[0]}`;

    return {
        main: `${mainDate}`,
        sub: `${dayOfWeek}, ${time}${tz}`
    };
}

const ICONS = {
    calendar: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M19,4H18V2H16V4H8V2H6V4H5C3.89,4 3.01,4.9 3.01,6L3,20C3,21.1 3.89,22 5,22H19C20.1,22 21,21.1 21,20V6C21,4.9 20.1,4 19,4M19,20H5V10H19V20M19,8H5V6H19V8Z"/></svg>`,
    aperture: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <g transform="translate(2.5, 2.5) scale(0.038)">
            <path fill="currentColor" d="M289.544,1.991l-74.577,129.132h267.532C446.312,65.22,373.904,11.416,289.544,1.991z 
                M52.053,102.727l74.542,129.149L260.36,0.19C185.189-1.428,102.395,34.375,52.053,102.727z 
                M20.544,358.77l149.118,0.018L35.896,127.102C-3.088,191.388-13.483,281.002,20.544,358.77z 
                M226.525,514.077l74.577-129.132H33.571C69.757,450.849,142.166,504.652,226.525,514.077z 
                M464.017,413.342l-74.542-129.149L255.709,515.878C330.88,517.496,413.675,481.693,464.017,413.342z 
                M495.525,157.299l-149.118-0.018l133.766,231.686C519.157,324.681,529.553,235.066,495.525,157.299z"/>
        </g>
    </svg>`,
    image: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M21,19V5C21,3.9 20.1,3 19,3H5C3.9,3 3,3.9 3,5V19C3,20.1 3.9,21 5,21H19C20.1,21 21,20.1 21,19M8.5,13.5L11,16.5L14.5,12L19,18H5L8.5,13.5Z"/></svg>`,
    location: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12,2C8.13,2 5,5.13 5,9C5,14.25 12,22 12,22C12,22 19,14.25 19,9C19,5.13 15.87,2 12,2M12,11.5C10.62,11.5 9.5,10.38 9.5,9C9.5,7.62 10.62,6.5 12,6.5C13.38,6.5 14.5,7.62 14.5,9C14.5,10.38 13.38,11.5 12,11.5Z"/></svg>`
};

/**
 * Обратное геокодирование (Координаты -> Адрес)
 */
async function getReverseGeocode(lat, lon) {
    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&accept-language=ru`, {
            headers: { 'User-Agent': 'YandexDiskExifViewer/1.0' }
        });
        const data = await res.json();
        if (data.address) {
            const city = data.address.city || data.address.town || data.address.village || data.address.hamlet;
            const country = data.address.country;
            if (city && country) return `${city}, ${country}`;
            if (country) return country;
        }
        return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    } catch (e) {
        return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    }
}

/**
 * Расчет мегапикселей и получение разрешения
 */
function getResolutionInfo(data) {
    const w = data.PixelXDimension || data.ImageWidth;
    const h = data.PixelYDimension || data.ImageHeight;
    if (!w || !h) return null;
    const mp = ((w * h) / 1000000).toFixed(0);
    return {
        main: `${mp} Мпикс.`,
        sub: `${w} × ${h}`
    };
}

function displayOverlay(data, errorMsg) {
    let overlay = document.getElementById('exif-info-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'exif-info-overlay';
        document.body.appendChild(overlay);
    }

    // Сохраняем текущий путь файла в оверлее, чтобы избежать дублирования данных
    const params = new URLSearchParams(location.search);
    const currentPath = params.get('idDialog');
    overlay.dataset.currentFile = currentPath;

    overlay.style.width = `${currentOverlayWidth}px`;

    if (!data) {
        overlay.innerHTML = `
            <div style="padding: 30px 16px; text-align: center; color: rgba(255,255,255,0.6);">
                <div style="width: 28px; height: 28px; margin: 0 auto 12px; color: rgba(255,255,255,0.7); opacity: 0.9;">
                    <svg width="100%" height="100%" viewBox="0 0 512 512" fill="currentColor" aria-hidden="true">
                        <path d="M332.998,291.918c52.2-71.895,45.941-173.338-18.834-238.123c-71.736-71.728-188.468-71.728-260.195,0c-71.746,71.745-71.746,188.458,0,260.204c64.775,64.775,166.218,71.034,238.104,18.844l14.222,14.203l40.916-40.916L332.998,291.918z M278.488,278.333c-52.144,52.134-136.699,52.144-188.852,0c-52.152-52.153-52.152-136.717,0-188.861c52.154-52.144,136.708-52.144,188.852,0C330.64,141.616,330.64,226.18,278.488,278.333z"/>
                        <path d="M109.303,119.216c-27.078,34.788-29.324,82.646-6.756,119.614c2.142,3.489,6.709,4.603,10.208,2.46c3.49-2.142,4.594-6.709,2.462-10.198v0.008c-19.387-31.7-17.45-72.962,5.782-102.771c2.526-3.228,1.946-7.898-1.292-10.405C116.48,115.399,111.811,115.979,109.303,119.216z"/>
                        <path d="M501.499,438.591L363.341,315.178l-47.98,47.98l123.403,138.168c12.548,16.234,35.144,13.848,55.447-6.456C514.505,474.576,517.743,451.138,501.499,438.591z"/>
                    </svg>
                </div>
                <div style="font-size: 13px; font-weight: 500; line-height: 1.4; color: #f0f0f0;">${errorMsg || 'EXIF данные не найдены'}</div>
            </div>
        `;

        createCloseButton(overlay);
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

    const dateInfo = parseExifDate(data.DateTimeOriginal);
    const resInfo = getResolutionInfo(data);

    // Собираем данные о камере (Производитель + Модель)
    let cameraMain = 'Неизвестная камера';
    if (data.Make || data.Model) {
        let make = (data.Make || '').trim();
        let model = (data.Model || '').trim();

        // Капитализируем первую букву бренда если нужно
        if (make) make = make.charAt(0).toUpperCase() + make.slice(1);

        if (make && model) {
            cameraMain = model.toLowerCase().includes(make.toLowerCase()) ? model : `${make} ${model}`;
        } else {
            cameraMain = model || make;
        }

        // На всякий случай еще раз убедимся что первая буква заглавная
        cameraMain = cameraMain.charAt(0).toUpperCase() + cameraMain.slice(1);
    }

    const cameraSub = [
        data.FNumber ? `f/${data.FNumber}` : null,
        data.ExposureTime ? formatExposure(data.ExposureTime) : null,
        data.FocalLength ? `${data.FocalLength} мм` : null,
        data.ISOSpeedRatings ? `ISO ${data.ISOSpeedRatings}` : null
    ].filter(v => v).join('\u00A0\u00A0\u00A0\u00A0');

    const excludeFields = ['Дата съёмки', 'Камера', 'Объектив', 'ISO', 'Выдержка', 'Диафрагма', 'Фокусное расстояние', 'Вспышка', 'GPS'];
    const rows = fields
        .filter(([k, v]) => v && !excludeFields.includes(k))
        .map(([k, v]) => `<p><b>${k}:</b> ${v}</p>`)
        .join('');

    const hasGPS = data.GPSLatitude && data.GPSLongitude;
    let lat = null, lon = null;
    if (hasGPS) {
        lat = convertDMS(data.GPSLatitude, data.GPSLatitudeRef);
        lon = convertDMS(data.GPSLongitude, data.GPSLongitudeRef);
    }

    overlay.innerHTML = `${dateInfo ? `
            <div class="exif-block">
                <div class="exif-block-icon">${ICONS.calendar}</div>
                <div class="exif-block-content">
                    <div class="exif-main-text">${dateInfo.main}</div>
                    <div class="exif-sub-text">${dateInfo.sub}</div>
                </div>
            </div>
        ` : ''}
        
        <div class="exif-block">
            <div class="exif-block-icon">${ICONS.aperture}</div>
            <div class="exif-block-content">
                <div class="exif-main-text">${cameraMain}</div>
                <div class="exif-sub-text">${cameraSub}</div>
            </div>
        </div>

        <div class="exif-block">
            <div class="exif-block-icon">${ICONS.image}</div>
            <div class="exif-block-content">
                <div class="exif-main-text">${currentPrefetchPath ? currentPrefetchPath.split('/').pop() : 'Изображение'}</div>
                <div class="exif-sub-text">${resInfo ? `${resInfo.main}\u00A0\u00A0\u00A0\u00A0${resInfo.sub}` : ''}</div>
            </div>
        </div>

        ${hasGPS ? `
            <a href="https://maps.google.com/?q=${lat},${lon}" target="_blank" style="text-decoration: none;">
                <div class="exif-block">
                    <div class="exif-block-icon">${ICONS.location}</div>
                    <div class="exif-block-content">
                        <div class="exif-main-text" id="exif-address">Загрузка адреса...</div>
                        <div class="exif-sub-text">${lat.toFixed(5)}, ${lon.toFixed(5)}</div>
                    </div>
                </div>
            </a>
            <div style="position: relative; width: 100%; margin: 4px 0 0 0; padding: 0;">
                <div id="exif-map" style="height: ${currentMapHeight}px; width: 100%; margin: 0; border-radius: 0 0 12px 12px; z-index: 10000; border: none; display: block;"></div>
                <div id="exif-map-resizer" style="position: absolute; bottom: 0; left: 0; width: 100%; height: 12px; cursor: ns-resize; z-index: 10001;"></div>
            </div>
        ` : ''}

        <div id="exif-right-resizer" style="position: absolute; top: 0; right: 0; width: 10px; height: 100%; cursor: ew-resize; z-index: 10001;"></div>
        <div id="exif-corner-resizer" style="position: absolute; bottom: 0; right: 0; width: 16px; height: 16px; cursor: nwse-resize; z-index: 10002;"></div>

        ${rows || (dateInfo ? '' : '<p style="padding: 6px 10px; font-size: 11px; color: rgba(255,255,255,0.5);">Данные отсутствуют</p>')}
    `;

    if (hasGPS) {
        renderMicroMap('exif-map', lat, lon, 15);

        const el = document.getElementById('exif-address');
        if (el) {
            if (data._cachedAddress) {
                el.textContent = data._cachedAddress;
            } else {
                getReverseGeocode(lat, lon).then(address => {
                    // ПРОВЕРКА: Если пользователь уже переключил фото, пока шел запрос - ничего не делаем
                    if (overlay.dataset.currentFile !== currentPath) return;

                    if (el) el.textContent = address;
                    data._cachedAddress = address; // Сохраняем для будущих открытий
                });
            }
        }

        // Логика изменения размеров (Resizable)
        const resizerH = document.getElementById('exif-map-resizer');
        const resizerW = document.getElementById('exif-right-resizer');
        const resizerC = document.getElementById('exif-corner-resizer');
        const mapEl = document.getElementById('exif-map');

        const initResize = (e, type) => {
            e.preventDefault();
            const startX = e.clientX;
            const startY = e.clientY;
            const startW = currentOverlayWidth;
            const startH = currentMapHeight;

            const onMouseMove = (moveEvent) => {
                if (type === 'W' || type === 'C') {
                    const deltaX = moveEvent.clientX - startX;
                    const maxWidth = window.innerWidth - 50;
                    currentOverlayWidth = Math.min(maxWidth, Math.max(220, startW + deltaX));
                    overlay.style.width = `${currentOverlayWidth}px`;
                }
                if (type === 'H' || type === 'C') {
                    const deltaY = moveEvent.clientY - startY;
                    const maxHeight = window.innerHeight - 80;

                    // Чтобы ограничить общую высоту оверлея, нам нужно учитывать его текущий размер
                    const overlayRect = overlay.getBoundingClientRect();
                    const otherBlocksHeight = overlayRect.height - mapEl.offsetHeight;

                    const newMapHeight = startH + deltaY;
                    currentMapHeight = Math.min(maxHeight - otherBlocksHeight, Math.max(120, newMapHeight));

                    mapEl.style.height = `${currentMapHeight}px`;
                    renderMicroMap('exif-map', lat, lon, 15);
                }
            };

            const onMouseUp = () => {
                window.removeEventListener('mousemove', onMouseMove);
                window.removeEventListener('mouseup', onMouseUp);
                document.body.style.cursor = 'default';
            };

            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
            document.body.style.cursor = type === 'W' ? 'ew-resize' : (type === 'H' ? 'ns-resize' : 'nwse-resize');
        };

        if (resizerH) resizerH.onmousedown = (e) => initResize(e, 'H');
        if (resizerW) resizerW.onmousedown = (e) => initResize(e, 'W');
        if (resizerC) resizerC.onmousedown = (e) => initResize(e, 'C');
    }

    createCloseButton(overlay);

    if (hasGPS) {
        renderMicroMap('exif-map', lat, lon, 15);
    }
}

const MAP_LAYERS = [
    { name: 'HOT', url: 'https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M5.926 20.574a7.26 7.26 0 0 0 3.039 1.511c.107.035.179-.105.107-.175-2.395-2.285-1.079-4.758-.107-5.873.693-.796 1.68-2.107 1.608-3.865 0-.176.18-.317.322-.211 1.359.703 2.288 2.25 2.538 3.515.394-.386.537-.984.537-1.511 0-.176.214-.317.393-.176 1.287 1.16 3.503 5.097-.072 8.19-.071.071 0 .212.072.177a8.761 8.761 0 0 0 3.003-1.442c5.827-4.5 2.037-12.48-.43-15.116-.321-.317-.893-.106-.893.351-.036.95-.322 2.004-1.072 2.707-.572-2.39-2.478-5.105-5.195-6.441-.357-.176-.786.105-.75.492.07 3.27-2.063 5.352-3.922 8.059-1.645 2.425-2.717 6.89.822 9.808z"/></svg>' },
    {
        name: 'Вело',
        url: 'https://a.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
        icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M16 6C17.1046 6 18 5.10457 18 4
                C18 2.89543 17.1046 2 16 2C14.8954 2 14 2.89543 14 4C14 5.10457 14.8954 6 16 6z
                M13.2428 5.52993C13.5738 5.61279 13.8397 5.85869 13.9482 6.18222
                C14.13 6.72461 14.3843 7.20048 14.697 7.59998C15.5586 8.70094 16.9495 9.32795 18.8356 9.01361
                C19.3804 8.92281 19.8956 9.29083 19.9864 9.8356C20.0772 10.3804 19.7092 10.8956 19.1644 10.9864
                C17.0282 11.3424 15.1791 10.7992 13.8435 9.60462L11.1291 11.9869L12.7524 13.8413
                C12.912 14.0236 13 14.2577 13 14.5V19C13 19.5523 12.5523 20 12 20C11.4477 20 11 19.5523 11 19
                V14.8759L8.9689 12.5556L8.92455 12.5059C8.68548 12.2386 8.28531 11.7911 8.11145 11.2626
                C8.00463 10.9379 7.97131 10.5628 8.08578 10.1667C8.1967 9.78279 8.42374 9.45733 8.7058 9.18044
                L8.71971 9.16705L12.3134 5.77299C12.5614 5.53871 12.9118 5.44708 13.2428 5.52993z
                M2 17C2 15.3431 3.34315 14 5 14C6.65685 14 8 15.3431 8 17C8 18.6569 6.65685 20 5 20
                C3.34315 20 2 18.6569 2 17zM5 12C2.23858 12 0 14.2386 0 17C0 19.7614 2.23858 22 5 22
                C7.76142 22 10 19.7614 10 17C10 14.2386 7.76142 12 5 12zM16 17C16 15.3431 17.3431 14 19 14
                C20.6569 14 22 15.3431 22 17C22 18.6569 20.6569 20 19 20C17.3431 20 16 18.6569 16 17z
                M19 12C16.2386 12 14 14.2386 14 17C14 19.7614 16.2386 22 19 22C21.7614 22 24 19.7614 24 17
                C24 14.2386 21.7614 12 19 12z"/>
        </svg>`
    },
    { name: 'OSM', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20.5 3l-.16.03L15 5.1 9 3 3.36 4.9c-.21.07-.36.25-.36.48V20.5c0 .28.22.5.5.5l.16-.03L9 18.9l6 2.1 5.64-1.9c.21-.07.36-.25.36-.48V3.5c0-.28-.22-.5-.5-.5zM15 19l-6-2.11V5l6 2.11V19z"/></svg>' },
    { name: 'Dark', url: 'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-3.03 0-5.5-2.47-5.5-5.5 0-1.82.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z"/></svg>' },
    { name: 'Voyager', url: 'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/></svg>' },
    { name: 'OSM DE', url: 'https://a.tile.openstreetmap.de/tiles/osmde/{z}/{x}/{y}.png', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>' },
    { name: 'ArcGIS', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>' }
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

    // Сначала загружаем сохраненные настройки из памяти браузера
    chrome.storage.local.get(['lastLayerIndex', 'lastZoom'], (result) => {
        if (result.lastLayerIndex !== undefined) {
            currentLayerIndex = result.lastLayerIndex;
        }
        if (result.lastZoom !== undefined) {
            currentZoom = result.lastZoom;
        }
        redraw(); // Рисуем только после того, как узнали какой слой и зум нужны
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
            <svg width="40" height="40" viewBox="0 0 24 24" fill="#3c3c3c">
                <path fill-rule="evenodd" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" stroke="#ffffff" stroke-width="0"/>
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
            top: 8px !important;
            left: 8px !important;
            margin: 0 !important;
            padding: 0 !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 8px !important;
            z-index: 20000 !important;
        `;

        const layerControls = document.createElement('div');
        layerControls.style.position = 'absolute';
        layerControls.style.bottom = '9px';
        layerControls.style.right = '8px';
        layerControls.style.zIndex = '2000';

        const btnStyle = `
            width: 26px !important; height: 26px !important; 
            background: white !important; border: none !important; 
            border-radius: 5px !important; cursor: pointer !important; 
            display: flex !important; align-items: center !important; justify-content: center !important;
            box-shadow: 0 2px 5px rgba(0,0,0,0.2) !important;
            color: #5c5c5c !important; transition: background 0.2s !important;
            padding: 0 !important; margin: 0 !important;
        `;

        const btnPlus = document.createElement('button');
        btnPlus.innerHTML = '+';
        btnPlus.style.cssText = btnStyle + 'font-size: 22px !important; font-weight: bold !important;';
        btnPlus.onclick = (e) => {
            e.stopPropagation();
            if (currentZoom < 19) {
                currentZoom++;
                chrome.storage.local.set({ lastZoom: currentZoom });
                redraw();
            }
        };

        const btnMinus = document.createElement('button');
        btnMinus.innerHTML = '−';
        btnMinus.style.cssText = btnStyle + 'font-size: 22px !important; font-weight: bold !important;';
        btnMinus.onclick = (e) => {
            e.stopPropagation();
            if (currentZoom > 1) {
                currentZoom--;
                chrome.storage.local.set({ lastZoom: currentZoom });
                redraw();
            }
        };

        const btnLayer = document.createElement('button');
        btnLayer.innerHTML = layer.icon;
        btnLayer.title = `Слой: ${layer.name}`;
        btnLayer.style.cssText = btnStyle;
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

        // Логика зума колесиком
        container.onwheel = (e) => {
            e.preventDefault();
            if (e.deltaY < 0) {
                if (currentZoom < 19) {
                    currentZoom++;
                    chrome.storage.local.set({ lastZoom: currentZoom });
                    redraw();
                }
            } else {
                if (currentZoom > 1) {
                    currentZoom--;
                    chrome.storage.local.set({ lastZoom: currentZoom });
                    redraw();
                }
            }
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

            // Если оверлей уже открыт - обновляем его
            if (document.getElementById('exif-info-overlay')) {
                showExifData(null);
            }

            // Запускаем предзагрузку немедленно
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
                    const centerY = Math.round(rect.top + rect.height / 2) - 2;
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
