# TechStar ERP — Public Website

موقع TechStar التعريفي باللغة العربية (RTL)، بتصميم متجاوب مع الجوال والتابلت والكمبيوتر.

## الخط المعتمد: DIN Next Arabic

يستخدم الموقع **DIN Next Arabic** لجميع العناوين والنصوص والأزرار والنماذج.
أوزان الخط المدعومة: Regular (400)، Medium (500)، Bold (700).

### التفعيل المباشر عبر GitHub CLI (الأسهل)

من جهازك الذي توجد عليه ملفات الخطوط الأصلية، ثبّت [GitHub CLI](https://cli.github.com/)، ثم نفذ `gh auth login` وثبّت حزم Python المطلوبة:

```bash
python -m pip install fonttools brotli
python scripts/activate-licensed-din-webfonts.py "din-next-lt-w23-regular(4).ttf" "din-next-lt-w23-medium(4).ttf" "alfont_com_AlFont_com_din-next-lt-w23-bold(4).ttf"
```

يجب تشغيل الأمر من **جذر المستودع محليًا** ووضع ملفات الخطوط الثلاثة في المجلد نفسه، أو إعطاء مساراتها الكاملة. ستولّد الأداة WOFF2 محليًا، وتخزّن قيمه داخل GitHub Actions Secrets الخاصة بالمستودع، ثم تطلب تشغيل النشر. لا تكتب قيم Base64 في المحادثات أو ترفع ملفات الخط إلى المستودع العام.

### تضمين Webfont المرخّص دون نشر ملفاته في GitHub العام

بما أن ترخيص Webfont متاح، يمكن تضمين نسخة WOFF2 في الموقع المنشور عن طريق **GitHub Actions Secrets**. لا تضع ملفات TTF أو WOFF2 الأصلية مباشرة في المستودع العام.

1. على جهاز موثوق، ثبّت أدوات التحويل `python -m pip install fonttools brotli`.
2. أنشئ ملفات WOFF2 والقيم المشفّرة باستخدام:

```bash
python scripts/prepare-licensed-din-webfonts.py "regular.ttf" "medium.ttf" "bold.ttf"
```

3. من [إعدادات Secrets](https://github.com/SulaimanAlsanani/techstar-erp/settings/secrets/actions) أضف **ثلاثة Repository Secrets** بقيم الملفات النصية الناتجة من مجلد `.private-font-secrets/`:

| Secret | محتوى الملف المطلوب |
|---|---|
| `TECHSTAR_DIN_REGULAR_WOFF2_B64` | Regular WOFF2 بصيغة Base64 |
| `TECHSTAR_DIN_MEDIUM_WOFF2_B64` | Medium WOFF2 بصيغة Base64 |
| `TECHSTAR_DIN_BOLD_WOFF2_B64` | Bold WOFF2 بصيغة Base64 |

4. شغّل [إجراء النشر](https://github.com/SulaimanAlsanani/techstar-erp/actions/workflows/deploy.yml) عبر **Run workflow** أو ارفع تحديثًا إلى `main`.
5. سيُفك ترميز الملفات داخل Runner المؤقت، وتُضمّن الأوزان الثلاثة في GitHub Pages فقط. تحقّق من رسالة نجاح تضمين الخط في سجل النشر.

الملفات الثلاثة ليست متاحة تلقائيًا لمجرد رفعها في المحادثة؛ يجب إدخال القيم في Secrets مرة واحدة. إذا غابت أي قيمة، يظل الموقع يعمل باستخدام الخط المثبّت محليًا أو الخط الاحتياطي.

**تنبيه الترخيص:** لا تُجرِ هذه الخطوات إلا إذا كان ترخيصك يسمح بتقديم ملفات Webfont لزوار الموقع العام. الملفات النصية الناتجة حساسة من حيث حقوق التوزيع؛ لا تشاركها ولا ترفعها إلى مستودع عام. التحويل يستخدم مجموعة أحرف عربية ولاتينية شائعة؛ قد تتطلب الحروف الإضافية إصدارًا موسعًا من Webfont.

## ما الذي يعمل في هذه النسخة؟

- الصفحة الرئيسية تعرض الباقات الست كاملة؛ زر في الغلاف ينقل الزائر إليها مباشرة، مع بحث فوري مُحسّن لأشكال الحروف العربية ومرادفات المتجر الإلكتروني.
- صفحة حلول TechStar، مع البحث والتصنيف وصفحات تفاصيل 14 حلًا.
- صفحة مقارنة الباقات وتطبيقاتها، مع إمكانية إظهار التطبيقات المختلفة فقط.
- نموذج طلب عرض فني يمكنه توليد ملخص ونسخه أو تنزيله محليًا، وحفظ مسودة اختيارية تنتهي بعد 7 أيام.
- واجهة توضيحية للمؤشرات دون إظهار أرقام مبيعات أو نسب أداء غير حقيقية.

> **تنبيه تشغيلي:** استقبال الطلبات في CRM لا يعمل حتى نشر Backend وتكوين `window.TECHSTAR_CONFIG.apiBaseUrl`. ظهور ملخص الطلب لا يعني أنه أُرسل للشركة. لا توجد قاعدة بيانات أو معلومات عملاء مخزّنة على GitHub Pages.

## تفعيل GitHub Pages

المستودع: `SulaimanAlsanani/techstar-erp`، والفرع: `main`.

1. افتح [Settings → Pages](https://github.com/SulaimanAlsanani/techstar-erp/settings/pages).
2. من **Build and deployment → Source** اختر **GitHub Actions**.
3. افتح [Actions → Deploy TechStar website to GitHub Pages](https://github.com/SulaimanAlsanani/techstar-erp/actions/workflows/deploy.yml)، وتأكد من نجاح خطوة Deploy GitHub Pages. يمكن تشغيلها يدويًا عبر Run workflow عند الحاجة.
4. عنوان الموقع المتوقع بعد نجاح النشر: https://sulaimanalsanani.github.io/techstar-erp/

إذا بقيت صفحة 404، راجع سجل الإجراء وتأكد من أن GitHub Pages مفعّل من الإعدادات.

## بنية المشروع

- `index.html`: الواجهة التفاعلية والبيانات الافتراضية العامة للعرض.
- `assets/techstar-icon.svg`: أيقونة الموقع.
- `scripts/check-homepage.mjs`: فحص JavaScript والباقات والتجاوب البنيوي قبل النشر.
- `404.html`: صفحة خطأ مخصصة.
- `robots.txt` و`sitemap.xml`: ملفات اكتشاف الصفحة الرئيسية.
- `site.webmanifest`: تعريف الهوية والألوان والأيقونة.
- `.github/workflows/deploy.yml`: يختبر الملفات ثم ينشر ملفات الموقع العامة **فقط**.
- `.github/workflows/quality.yml`: يجري فحوصًا مستقلة للموقع عند تحديث `main` أو تقديم Pull Request.

## الاختبار محليًا

شغّل الخادم من مجلد المشروع:

```bash
python3 -m http.server 8000
```

ثم افتح http://localhost:8000/ . وللتحقق من سلامة المصدر، شغّل:

```bash
node scripts/check-homepage.mjs
```

## ما يلزم قبل الإطلاق الكامل

ربط واجهة الموقع مع Cloudflare Worker وقاعدة D1، إنشاء أول حساب مدير بأمان، ضبط CORS والأسرار، اعتماد بيان خصوصية، وإجراء اختبارات Staging حقيقية قبل استقبال بيانات العملاء.

لا تُضف رموز API أو كلمات مرور أو بيانات العملاء إلى الملفات المنشورة.
