/* حساب مواقيت الصلاة على الجهاز (بدون إنترنت) + قائمة الدول والمدن وطرق الحساب.
 * ملف مشترك: الواجهة تحسب به المواقيت، والخادم يفحص به إعدادات المستخدم (نفس القوائم في المكانين).
 * الخوارزمية الفلكية المعروفة (praytimes): موضع الشمس من التاريخ اليولياني، ثم زوايا الفجر والعشاء حسب طريقة الحساب.
 * الأوقات تُحسب لحظات مطلقة (UTC) وتُعرض بتوقيت الدولة المختارة، فلا تعتمد على منطقة ساعة الكمبيوتر. */
'use strict';

const Prayer = {};

Prayer.NAMES = { fajr: 'الفجر', dhuhr: 'الظهر', asr: 'العصر', maghrib: 'المغرب', isha: 'العشاء' };
Prayer.KEYS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];

/* زاوية الفجر والعشاء بالدرجات، أو العشاء بعد المغرب بعدد دقائق ثابت */
Prayer.METHODS = {
  egypt: { label: 'الهيئة المصرية العامة للمساحة', fajr: 19.5, isha: 17.5 },
  ummalqura: { label: 'أم القرى (السعودية)', fajr: 18.5, ishaMin: 90 },
  mwl: { label: 'رابطة العالم الإسلامي', fajr: 18, isha: 17 },
  dubai: { label: 'دبي (الإمارات)', fajr: 18.2, isha: 18.2 },
  kuwait: { label: 'الكويت', fajr: 18, isha: 17.5 },
  qatar: { label: 'قطر', fajr: 18, ishaMin: 90 },
  jordan: { label: 'الأردن', fajr: 18, isha: 18 },
  turkey: { label: 'تركيا (الشؤون الدينية)', fajr: 18, isha: 17 },
  morocco: { label: 'المغرب', fajr: 19, isha: 17 },
  algeria: { label: 'الجزائر', fajr: 18, isha: 17 },
  tunisia: { label: 'تونس', fajr: 18, isha: 18 },
  karachi: { label: 'جامعة العلوم الإسلامية بكراتشي', fajr: 18, isha: 18 },
  isna: { label: 'أمريكا الشمالية (ISNA)', fajr: 15, isha: 15 },
  singapore: { label: 'سنغافورة وماليزيا وإندونيسيا', fajr: 20, isha: 18 },
  france: { label: 'فرنسا (UOIF)', fajr: 12, isha: 12 },
};

/* الدول: المنطقة الزمنية وطريقة الحساب الافتراضية والمدن [المعرّف، الاسم، العرض، الطول، منطقة زمنية خاصة بالمدينة] */
Prayer.COUNTRIES = {
  EG: { name: 'مصر', tz: 'Africa/Cairo', method: 'egypt', cities: [
    ['cairo', 'القاهرة', 30.0444, 31.2357], ['giza', 'الجيزة', 30.0131, 31.2089], ['alex', 'الإسكندرية', 31.2001, 29.9187],
    ['portsaid', 'بورسعيد', 31.2653, 32.3019], ['suez', 'السويس', 29.9668, 32.5498], ['ismailia', 'الإسماعيلية', 30.5965, 32.2715],
    ['mansoura', 'المنصورة', 31.0409, 31.3785], ['tanta', 'طنطا', 30.7865, 31.0004], ['zagazig', 'الزقازيق', 30.5877, 31.502],
    ['damietta', 'دمياط', 31.4165, 31.8133], ['fayoum', 'الفيوم', 29.3084, 30.8428], ['benisuef', 'بني سويف', 29.0661, 31.0994],
    ['minya', 'المنيا', 28.1099, 30.7503], ['assiut', 'أسيوط', 27.1809, 31.1837], ['sohag', 'سوهاج', 26.5591, 31.6957],
    ['qena', 'قنا', 26.1551, 32.716], ['luxor', 'الأقصر', 25.6872, 32.6396], ['aswan', 'أسوان', 24.0889, 32.8998],
    ['hurghada', 'الغردقة', 27.2579, 33.8116], ['sharm', 'شرم الشيخ', 27.9158, 34.33], ['matrouh', 'مرسى مطروح', 31.3543, 27.2373]] },
  SA: { name: 'السعودية', tz: 'Asia/Riyadh', method: 'ummalqura', cities: [
    ['makkah', 'مكة المكرمة', 21.3891, 39.8579], ['madinah', 'المدينة المنورة', 24.5247, 39.5692], ['riyadh', 'الرياض', 24.7136, 46.6753],
    ['jeddah', 'جدة', 21.4858, 39.1925], ['dammam', 'الدمام', 26.4207, 50.0888], ['taif', 'الطائف', 21.2703, 40.4158],
    ['abha', 'أبها', 18.2164, 42.5053], ['tabuk', 'تبوك', 28.3835, 36.5662]] },
  AE: { name: 'الإمارات', tz: 'Asia/Dubai', method: 'dubai', cities: [
    ['dubai', 'دبي', 25.2048, 55.2708], ['abudhabi', 'أبوظبي', 24.4539, 54.3773], ['sharjah', 'الشارقة', 25.3463, 55.4209], ['alain', 'العين', 24.2075, 55.7447]] },
  KW: { name: 'الكويت', tz: 'Asia/Kuwait', method: 'kuwait', cities: [['kuwait', 'مدينة الكويت', 29.3759, 47.9774]] },
  QA: { name: 'قطر', tz: 'Asia/Qatar', method: 'qatar', cities: [['doha', 'الدوحة', 25.2854, 51.531]] },
  BH: { name: 'البحرين', tz: 'Asia/Bahrain', method: 'mwl', cities: [['manama', 'المنامة', 26.2285, 50.586]] },
  OM: { name: 'عُمان', tz: 'Asia/Muscat', method: 'mwl', cities: [['muscat', 'مسقط', 23.588, 58.3829]] },
  JO: { name: 'الأردن', tz: 'Asia/Amman', method: 'jordan', cities: [['amman', 'عمّان', 31.9539, 35.9106], ['irbid', 'إربد', 32.5568, 35.8469]] },
  PS: { name: 'فلسطين', tz: 'Asia/Hebron', method: 'mwl', cities: [['quds', 'القدس', 31.7683, 35.2137], ['gaza', 'غزة', 31.5017, 34.4668, 'Asia/Gaza']] },
  LB: { name: 'لبنان', tz: 'Asia/Beirut', method: 'mwl', cities: [['beirut', 'بيروت', 33.8938, 35.5018]] },
  SY: { name: 'سوريا', tz: 'Asia/Damascus', method: 'mwl', cities: [['damascus', 'دمشق', 33.5138, 36.2765], ['aleppo', 'حلب', 36.2021, 37.1343]] },
  IQ: { name: 'العراق', tz: 'Asia/Baghdad', method: 'mwl', cities: [['baghdad', 'بغداد', 33.3152, 44.3661], ['basra', 'البصرة', 30.5085, 47.7804], ['erbil', 'أربيل', 36.1911, 44.0092]] },
  YE: { name: 'اليمن', tz: 'Asia/Aden', method: 'mwl', cities: [['sanaa', 'صنعاء', 15.3694, 44.191], ['aden', 'عدن', 12.7855, 45.0187]] },
  SD: { name: 'السودان', tz: 'Africa/Khartoum', method: 'egypt', cities: [['khartoum', 'الخرطوم', 15.5007, 32.5599], ['portsudan', 'بورتسودان', 19.6158, 37.2164]] },
  LY: { name: 'ليبيا', tz: 'Africa/Tripoli', method: 'egypt', cities: [['tripoli', 'طرابلس', 32.8872, 13.1913], ['benghazi', 'بنغازي', 32.1167, 20.0667]] },
  TN: { name: 'تونس', tz: 'Africa/Tunis', method: 'tunisia', cities: [['tunis', 'تونس', 36.8065, 10.1815], ['sfax', 'صفاقس', 34.7406, 10.7603]] },
  DZ: { name: 'الجزائر', tz: 'Africa/Algiers', method: 'algeria', cities: [['algiers', 'الجزائر', 36.7538, 3.0588], ['oran', 'وهران', 35.6971, -0.6308], ['constantine', 'قسنطينة', 36.365, 6.6147]] },
  MA: { name: 'المغرب', tz: 'Africa/Casablanca', method: 'morocco', cities: [
    ['rabat', 'الرباط', 34.0209, -6.8416], ['casablanca', 'الدار البيضاء', 33.5731, -7.5898], ['marrakesh', 'مراكش', 31.6295, -7.9811],
    ['fes', 'فاس', 34.0181, -5.0078], ['tangier', 'طنجة', 35.7595, -5.834]] },
  TR: { name: 'تركيا', tz: 'Europe/Istanbul', method: 'turkey', cities: [['istanbul', 'إسطنبول', 41.0082, 28.9784], ['ankara', 'أنقرة', 39.9334, 32.8597]] },
  GB: { name: 'بريطانيا', tz: 'Europe/London', method: 'mwl', cities: [['london', 'لندن', 51.5074, -0.1278], ['manchester', 'مانشستر', 53.4808, -2.2426], ['birmingham', 'برمنجهام', 52.4862, -1.8904]] },
  DE: { name: 'ألمانيا', tz: 'Europe/Berlin', method: 'mwl', cities: [['berlin', 'برلين', 52.52, 13.405], ['munich', 'ميونخ', 48.1351, 11.582]] },
  FR: { name: 'فرنسا', tz: 'Europe/Paris', method: 'france', cities: [['paris', 'باريس', 48.8566, 2.3522], ['marseille', 'مارسيليا', 43.2965, 5.3698]] },
  US: { name: 'الولايات المتحدة', tz: 'America/New_York', method: 'isna', cities: [
    ['newyork', 'نيويورك', 40.7128, -74.006], ['detroit', 'ديترويت', 42.3314, -83.0458, 'America/Detroit'],
    ['chicago', 'شيكاغو', 41.8781, -87.6298, 'America/Chicago'], ['houston', 'هيوستن', 29.7604, -95.3698, 'America/Chicago'],
    ['losangeles', 'لوس أنجلوس', 34.0522, -118.2437, 'America/Los_Angeles']] },
  CA: { name: 'كندا', tz: 'America/Toronto', method: 'isna', cities: [
    ['toronto', 'تورونتو', 43.6532, -79.3832], ['montreal', 'مونتريال', 45.5017, -73.5673], ['vancouver', 'فانكوفر', 49.2827, -123.1207, 'America/Vancouver']] },
  PK: { name: 'باكستان', tz: 'Asia/Karachi', method: 'karachi', cities: [['karachi', 'كراتشي', 24.8607, 67.0011], ['lahore', 'لاهور', 31.5204, 74.3587], ['islamabad', 'إسلام آباد', 33.6844, 73.0479]] },
  IN: { name: 'الهند', tz: 'Asia/Kolkata', method: 'karachi', cities: [['delhi', 'دلهي', 28.6139, 77.209], ['mumbai', 'مومباي', 19.076, 72.8777]] },
  ID: { name: 'إندونيسيا', tz: 'Asia/Jakarta', method: 'singapore', cities: [['jakarta', 'جاكرتا', -6.2088, 106.8456]] },
  MY: { name: 'ماليزيا', tz: 'Asia/Kuala_Lumpur', method: 'singapore', cities: [['kualalumpur', 'كوالالمبور', 3.139, 101.6869]] },
};

/* كل المناطق الزمنية المسموحة لدولة (للإحداثيات اليدوية في دولة فيها أكثر من توقيت) */
Prayer.zonesOf = (cc) => {
  const c = Prayer.COUNTRIES[cc];
  if (!c) return [];
  return [...new Set([c.tz, ...c.cities.map((x) => x[4]).filter(Boolean)])];
};

/* مكان المستخدم من إعداداته: {lat, lng, tz, label} أو null */
Prayer.place = (pr) => {
  const c = pr && Prayer.COUNTRIES[pr.country];
  if (!c) return null;
  if (pr.city === 'custom') return { lat: pr.lat, lng: pr.lng, tz: pr.tz || c.tz, label: 'موقع مخصص · ' + c.name };
  const city = c.cities.find((x) => x[0] === pr.city);
  if (!city) return null;
  return { lat: city[2], lng: city[3], tz: city[4] || c.tz, label: city[1] };
};

/* ===== الحساب الفلكي (داخل دالة حتى لا تتسرب أسماء عامة للصفحة) ===== */
(() => {
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const fixA = (a) => { a -= 360 * Math.floor(a / 360); return a < 0 ? a + 360 : a; };
const fixH = (a) => { a -= 24 * Math.floor(a / 24); return a < 0 ? a + 24 : a; };

function sun(jd) {
  const D = jd - 2451545.0;
  const g = fixA(357.529 + 0.98560028 * D);
  const q = fixA(280.459 + 0.98564736 * D);
  const L = fixA(q + 1.915 * Math.sin(rad(g)) + 0.020 * Math.sin(rad(2 * g)));
  const e = 23.439 - 0.00000036 * D;
  const ra = deg(Math.atan2(Math.cos(rad(e)) * Math.sin(rad(L)), Math.cos(rad(L)))) / 15;
  return { decl: deg(Math.asin(Math.sin(rad(e)) * Math.sin(rad(L)))), eqt: q / 15 - fixH(ra) };
}

/* مواقيت يوم (y, m, d حسب تقويم مكان الصلاة) كلحظات مطلقة (ms). asr: 'std' شافعي، 'hanafi' حنفي */
Prayer.times = ({ y, m, d }, place, methodId, asr) => {
  const method = Prayer.METHODS[methodId] || Prayer.METHODS.mwl;
  const lat = place.lat, lng = place.lng;
  const jd0 = 367 * y - Math.floor((7 * (y + Math.floor((m + 9) / 12))) / 4) + Math.floor((275 * m) / 9) + d + 1721013.5 - lng / 360;
  const noonAt = (t) => fixH(12 - sun(jd0 + t).eqt);
  const angleAt = (angle, t, before) => {
    const s = sun(jd0 + t);
    const cosT = (-Math.sin(rad(angle)) - Math.sin(rad(s.decl)) * Math.sin(rad(lat))) / (Math.cos(rad(s.decl)) * Math.cos(rad(lat)));
    if (cosT < -1 || cosT > 1) return NaN; // خطوط عرض عالية: الشمس لا تبلغ الزاوية
    const T = deg(Math.acos(cosT)) / 15;
    return noonAt(t) + (before ? -T : T);
  };
  const asrAt = (t) => {
    const s = sun(jd0 + t);
    const factor = asr === 'hanafi' ? 2 : 1;
    return angleAt(-deg(Math.atan(1 / (factor + Math.tan(rad(Math.abs(lat - s.decl)))))), t, false);
  };
  // تقريب أولي ثم إعادة الحساب بالأوقات الناتجة (دقة أعلى)
  let t = { fajr: 5, sunrise: 6, dhuhr: 12, asr: 13, sunset: 18, isha: 18 };
  for (let i = 0; i < 2; i++) {
    const f = (x) => x / 24;
    t = {
      fajr: angleAt(method.fajr, f(t.fajr), true),
      sunrise: angleAt(0.833, f(t.sunrise), true),
      dhuhr: noonAt(f(t.dhuhr)),
      asr: asrAt(f(t.asr)),
      sunset: angleAt(0.833, f(t.sunset), false),
      isha: method.ishaMin ? t.sunset : angleAt(method.isha, f(t.isha), false),
    };
  }
  // خطوط العرض العالية: جزء من الليل بنسبة الزاوية (الطريقة المعتادة)
  const night = fixH(t.sunrise - t.sunset);
  const nightPart = (angle) => (angle / 60) * night;
  if (isNaN(t.fajr) || fixH(t.sunrise - t.fajr) > nightPart(method.fajr)) t.fajr = t.sunrise - nightPart(method.fajr);
  if (method.ishaMin) t.isha = t.sunset + method.ishaMin / 60;
  else if (isNaN(t.isha) || fixH(t.isha - t.sunset) > nightPart(method.isha)) t.isha = t.sunset + nightPart(method.isha);
  // من التوقيت الشمسي المحلي إلى UTC، ثم لحظة مطلقة
  const base = Date.UTC(y, m - 1, d);
  const at = (hrs) => base + Math.round((hrs - lng / 15) * 3600) * 1000;
  return { fajr: at(t.fajr), sunrise: at(t.sunrise), dhuhr: at(t.dhuhr), asr: at(t.asr), maghrib: at(t.sunset), isha: at(t.isha) };
};
})();

/* تاريخ اليوم (سنة/شهر/يوم) في منطقة زمنية */
Prayer.ymdIn = (ms, tz) => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)).split('-').map(Number);
  return { y: p[0], m: p[1], d: p[2] };
};
Prayer.dayKey = ({ y, m, d }) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
Prayer.nextDay = ({ y, m, d }) => { const n = new Date(Date.UTC(y, m - 1, d + 1)); return { y: n.getUTCFullYear(), m: n.getUTCMonth() + 1, d: n.getUTCDate() }; };

/* مواقيت يوم في مكان المستخدم: {day, times} */
Prayer.forDay = (pr, ms, offsetDays) => {
  const place = Prayer.place(pr);
  if (!place) return null;
  let day = Prayer.ymdIn(ms, place.tz);
  for (let i = 0; i < (offsetDays || 0); i++) day = Prayer.nextDay(day);
  return { day, place, times: Prayer.times(day, place, pr.method, pr.asr) };
};

Prayer.fmtTime = (ms, tz) => new Date(ms).toLocaleTimeString('ar-EG-u-nu-latn', { timeZone: tz, hour: 'numeric', minute: '2-digit' });

/* الصلاة القادمة بعد لحظة: {key, at, place} */
Prayer.next = (pr, now) => {
  for (let off = 0; off < 2; off++) {
    const r = Prayer.forDay(pr, now, off);
    if (!r) return null;
    for (const k of Prayer.KEYS) if (r.times[k] > now) return { key: k, at: r.times[k], place: r.place };
  }
  return null;
};

/* ===== إعدادات تذكيرات الراحة لكل مستخدم (نفس الشكل في الواجهة والخادم) ===== */
Prayer.IQAMA = { fajr: 20, dhuhr: 15, asr: 15, maghrib: 10, isha: 15 };
Prayer.defaults = () => ({
  prayer: {
    on: false, country: 'EG', city: 'cairo', lat: null, lng: null, tz: null, method: 'egypt', asr: 'std',
    stages: Object.fromEntries(Prayer.KEYS.map((k) => [k, { pre: true, preMin: 5, adhan: true, iqama: true, iqamaMin: Prayer.IQAMA[k] }])),
  },
  water: { on: false, min: 60 },
  move: { on: false, min: 50 },
  eye: { on: false, min: 20 },
  sound: 'chime',
});

/* فحص صارم: يرجع إعدادات نظيفة أو يرمي خطأ 400. أي حقل ناقص يأخذ القيمة الافتراضية */
Prayer.clean = (input) => {
  const bad = (msg) => { throw Object.assign(new Error(msg), { status: 400, code: 'bad-input' }); };
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  const bool = (v, def) => (v === undefined ? def : typeof v === 'boolean' ? v : bad('قيمة تشغيل غير صالحة'));
  const int = (v, def, lo, hi) => {
    if (v === undefined) return def;
    if (!Number.isInteger(v) || v < lo || v > hi) bad(`المدة لازم تكون رقم صحيح من ${lo} إلى ${hi}`);
    return v;
  };
  if (!isObj(input)) bad('إعدادات غير صالحة');
  const d = Prayer.defaults();
  const ip = input.prayer === undefined ? {} : isObj(input.prayer) ? input.prayer : bad('إعدادات الصلاة غير صالحة');
  const country = ip.country === undefined ? d.prayer.country : ip.country;
  const c = Object.prototype.hasOwnProperty.call(Prayer.COUNTRIES, country) ? Prayer.COUNTRIES[country] : bad('دولة غير معروفة');
  const city = ip.city === undefined ? c.cities[0][0] : ip.city;
  const out = { prayer: { on: bool(ip.on, false), country, city, lat: null, lng: null, tz: null, method: c.method, asr: 'std', stages: {} } };
  if (city === 'custom') {
    const lat = Number(ip.lat), lng = Number(ip.lng);
    if (typeof ip.lat !== 'number' || !isFinite(lat) || lat < -66 || lat > 66) bad('خط العرض لازم يكون بين -66 و 66');
    if (typeof ip.lng !== 'number' || !isFinite(lng) || lng < -180 || lng > 180) bad('خط الطول لازم يكون بين -180 و 180');
    const zones = Prayer.zonesOf(country);
    const tz = ip.tz == null ? zones[0] : ip.tz;
    if (!zones.includes(tz)) bad('توقيت غير مناسب للدولة');
    Object.assign(out.prayer, { lat: Math.round(lat * 1e4) / 1e4, lng: Math.round(lng * 1e4) / 1e4, tz });
  } else if (!c.cities.some((x) => x[0] === city)) bad('مدينة غير معروفة');
  if (ip.method !== undefined) out.prayer.method = Object.prototype.hasOwnProperty.call(Prayer.METHODS, ip.method) ? ip.method : bad('طريقة حساب غير معروفة');
  if (ip.asr !== undefined) out.prayer.asr = ip.asr === 'std' || ip.asr === 'hanafi' ? ip.asr : bad('حساب العصر غير معروف');
  const st = ip.stages === undefined ? {} : isObj(ip.stages) ? ip.stages : bad('مراحل الصلاة غير صالحة');
  for (const k of Prayer.KEYS) {
    const s = st[k] === undefined ? {} : isObj(st[k]) ? st[k] : bad('مراحل الصلاة غير صالحة');
    const ds = d.prayer.stages[k];
    out.prayer.stages[k] = {
      pre: bool(s.pre, ds.pre), preMin: int(s.preMin, ds.preMin, 1, 60),
      adhan: bool(s.adhan, ds.adhan),
      iqama: bool(s.iqama, ds.iqama), iqamaMin: int(s.iqamaMin, ds.iqamaMin, 1, 60),
    };
  }
  for (const [k, lo, hi] of [['water', 15, 240], ['move', 15, 240], ['eye', 10, 120]]) {
    const v = input[k] === undefined ? {} : isObj(input[k]) ? input[k] : bad('إعدادات التذكير غير صالحة');
    out[k] = { on: bool(v.on, false), min: int(v.min, d[k].min, lo, hi) };
  }
  out.sound = input.sound === undefined ? d.sound : input.sound === 'chime' || input.sound === 'none' ? input.sound : bad('اختيار الصوت غير صالح');
  return out;
};

if (typeof module !== 'undefined' && module.exports) module.exports = Prayer;
