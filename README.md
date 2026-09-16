# RAJA Entertainment Ludo — deployment-ready

Entertainment-only Ludo site with virtual points. No cash deposits, withdrawals, betting, or real-money prizes.

## Included
- Mobile-first RAJA-style UI
- Account creation with 10-digit mobile + display name + 4–6 digit PIN
- Secure salted scrypt PIN hashes
- Login session shared with Socket.IO
- 2–4 player private rooms
- Room code, Ready, Start, Dice, Pawns, Rematch
- Room chat
- SQLite game history
- `/health` endpoint
- Dockerfile for Node hosting
- Persistent database directory via `DATA_DIR`

## Local run
```bash
npm install
npm start
```
Open `http://localhost:3000`.

## Production environment
Set:
- `NODE_ENV=production`
- `SESSION_SECRET` to a long random secret
- `DATA_DIR` to a persistent writable directory (for example `/data`)
- `PORT` if your host supplies one

Use an HTTPS-capable Node host. The host must support a long-running Node process, WebSockets/Socket.IO, native npm modules, and persistent disk if you want accounts/history to survive restarts.

## Important
The mobile number is an account identifier; this version does not verify ownership by SMS OTP. Do not present it as OTP-verified login. If you later add OTP, use a legitimate SMS/OTP provider and collect only necessary data.
