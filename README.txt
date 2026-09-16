RAJA Entertainment v4 — Mobile ID/Login

अब user:
1. 10-digit mobile number + name + 4-6 digit PIN से ID बना सकता है.
2. उसी mobile number + PIN से बाद में login कर सकता है.
3. Login session server पर रहता है.
4. Login के बाद private Room Create/Join कर सकता है.
5. 2-4 players real-time Ludo prototype खेल सकते हैं.

IMPORTANT:
- यह mobile-number based account है, लेकिन OTP verification नहीं है.
- Real OTP login के लिए Firebase/Twilio/MSG91 जैसे SMS provider की credentials और configuration चाहिए.
- Public website बनाने के लिए इस Node.js project को HTTPS hosting पर deploy करना होगा.
- इस version में cash deposit/withdrawal, betting या real-money prizes नहीं हैं; points virtual हैं.

Run:
npm install
npm start
Open: http://localhost:3000

Production:
Set SESSION_SECRET and PIN_SALT environment variables.
Use HTTPS.
For real OTP, add an SMS/OTP provider and verify phone ownership.
