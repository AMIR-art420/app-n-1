# پیام‌رسان — نسخه بتا (رایگان)

## ترتیب کار
1. مخزن GitHub **عمومی (Public)** بساز و کل این پوشه را آپلود کن.
2. سرور را روی Render بالا بیاور: Render → New → Blueprint → همین مخزن (فایل `render.yaml` آماده است). آدرس را کپی کن، مثلاً `https://payamresan-xxxx.onrender.com`
3. در `capacitor.config.json` مقدار `https://YOURDOMAIN.com` را با آن آدرس عوض کن و commit کن.
4. در GitHub → Actions → Build APK اجرا می‌شود (یا Run workflow بزن).
5. بعد از چند دقیقه APK در بخش Releases است. لینک ثابت دانلود:
   `https://github.com/USER/REPO/releases/latest/download/payamresan-beta.apk`

## محدودیت‌های نسخه رایگان
- سرور رایگان Render بعد از ۱۵ دقیقه بی‌استفاده می‌خوابد و بیدار شدنش حدود ۳۰ تا ۶۰ ثانیه طول می‌کشد.
- دیسک رایگان موقت است: با هر ری‌استارت یا دیپلوی دوباره، اتاق‌ها و پیام‌ها پاک می‌شوند. برای بتا قابل قبول است؛ برای ماندگاری باید VPS رایگان/ارزان با دیسک دائمی استفاده شود (SERVER.md).
- APK از نوع debug است؛ کاربران باید «نصب از منابع ناشناس» را روشن کنند.
