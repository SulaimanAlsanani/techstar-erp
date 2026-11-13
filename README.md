# TechStar ERP — Public Website

موقع TechStar التعريفي باللغة العربية (RTL)، بتصميم متجاوب مع الجوال والتابلت والكمبيوتر.

## ما الذي يعمل في هذه النسخة؟

- الصفحة الرئيسية، وست باقات تظهر بالكامل، مع بحث فوري باسم الباقة أو التطبيق المشمول.
- صفحة حلول TechStar، مع البحث والتصنيف وصفحات تفاصيل 14 حلًا.
- صفحة مقارنة الباقات وتطبيقاتها.
- نموذج طلب عرض فني يمكنه توليد ملخص ونسخه أو تنزيله محليًا.

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
