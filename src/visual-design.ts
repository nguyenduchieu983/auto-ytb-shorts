import sharp from 'sharp';
const esc = (s: string) =>
  s.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!,
  );
function wrap(s: string, width: number) {
  const rows: string[] = [];
  let row = '';
  for (const word of s.split(/\s+/)) {
    if ((row + ' ' + word).trim().length > width && row) {
      rows.push(row);
      row = word;
    } else row = (row + ' ' + word).trim();
  }
  if (row) rows.push(row);
  return rows;
}
export async function editorialCard(
  path: string,
  headline: string,
  source: string,
  brand: string,
  mock: boolean,
  image?: Buffer,
  type = 'headline-card',
  index = 1,
  labels: string[] = [],
) {
  const colors = ['#62ead5', '#a6b6ff', '#ffcf83'];
  const accent = colors[(index - 1) % colors.length];
  const metric =
    type === 'metric-card'
      ? headline.match(/\d[\d.,]*(?:\s*(?:tỷ|triệu|nghìn|%|GB|USD|TB))*/i)?.[0]
      : undefined;
  const rows = wrap(headline, image ? 24 : 21);
  const font = rows.length > 4 ? 65 : 78;
  const y = image ? 390 : metric ? 1040 : 560;
  const label = mock ? 'DEMO · DỮ LIỆU MẪU' : image ? 'HÌNH MINH HỌA AI' : 'ĐIỂM ĐÁNG CHÚ Ý';
  const safeLabels = labels.filter(Boolean).slice(0, 3);
  const labelSvg = (text: string, x: number, y: number) =>
    wrap(text, 14)
      .slice(0, 3)
      .map(
        (row, i) =>
          `<text x="${x}" y="${y + i * 43}" text-anchor="middle" font-family="Arial" font-size="34" font-weight="bold" fill="white">${esc(row)}</text>`,
      )
      .join('');
  const diagram =
    safeLabels.length >= 2 && (type === 'motion-card' || type === 'comparison-card')
      ? safeLabels
          .map((label, i) => {
            const x = 80 + i * (900 / safeLabels.length);
            return `<rect x="${x}" y="960" width="${860 / safeLabels.length}" height="300" rx="25" fill="${i % 2 ? '#214c50' : '#213849'}"/>${labelSvg(label, x + 430 / safeLabels.length, 1070)}`;
          })
          .join('')
      : !image && !metric
        ? safeLabels
            .map(
              (label, i) =>
                `<rect x="80" y="${940 + i * 100}" width="850" height="78" rx="14" fill="#193346"/><text x="115" y="${993 + i * 100}" font-family="Arial" font-size="35" fill="${accent}">${esc(label)}</text>`,
            )
            .join('')
        : '';
  const bg = `<svg width="1080" height="1920"><defs><linearGradient id="b" x2="1" y2="1"><stop stop-color="#091c28"/><stop offset="1" stop-color="#11233d"/></linearGradient></defs><rect width="1080" height="1920" fill="url(#b)"/><circle cx="950" cy="850" r="430" fill="${accent}" opacity=".06"/><path d="M100 1300L950 450M200 1400L1050 550" stroke="${accent}" opacity=".09" stroke-width="2"/>${diagram}</svg>`;
  if (image) await sharp(image).resize(1080, 1920, { fit: 'cover' }).png().toFile(path);
  else await sharp(Buffer.from(bg)).png().toFile(path);
  const overlay = `<svg width="1080" height="1920"><defs><linearGradient id="shade" x2="0" y2="1"><stop stop-color="#06101d" stop-opacity=".93"/><stop offset=".55" stop-color="#06101d" stop-opacity=".05"/><stop offset="1" stop-color="#06101d" stop-opacity=".97"/></linearGradient></defs>${image ? '<rect width="1080" height="1920" fill="url(#shade)"/>' : ''}<rect x="80" y="175" width="8" height="45" fill="${accent}"/><text x="108" y="210" font-family="Arial" font-size="30" font-weight="bold" fill="white">${esc(brand)}</text><text x="80" y="285" font-family="Arial" font-size="23" letter-spacing="3" fill="${accent}">${esc(label)}</text>${metric ? `<text x="78" y="885" font-family="Arial" font-size="${metric.length > 10 ? 100 : 160}" font-weight="bold" fill="${accent}">${esc(metric)}</text>` : ''}${rows
    .slice(0, 6)
    .map(
      (row, i) =>
        `<text x="80" y="${y + i * (font + 18)}" font-family="Arial" font-size="${font}" font-weight="bold" fill="white">${esc(row)}</text>`,
    )
    .join(
      '',
    )}<rect x="80" y="${Math.min(1330, y + rows.length * (font + 18) + 20)}" width="130" height="7" fill="${accent}"/><text x="80" y="1380" font-family="Arial" font-size="23" fill="#c8d9e1">${esc(source.slice(0, 58))}</text><text x="80" y="1720" font-family="Arial" font-size="24" fill="#9daebb">${String(index).padStart(2, '0')} / AI &amp; TECH</text></svg>`;
  await sharp(Buffer.from(overlay))
    .png()
    .toFile(path.replace(/\.png$/, '-overlay.png'));
}
