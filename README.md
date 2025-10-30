# GlowChat — Production-ready scaffold (development)

This repository is a **production-ready scaffold** for GlowChat with many integrations prepared.
**Important:** This is still code you must configure with your credentials and deploy to a host.

## What this scaffold includes
- Express + Socket.IO backend with Postgres (preferred) or SQLite fallback
- Redis service (included in docker-compose) for future socket adapter/presence
- MinIO (local S3-compatible) for local dev or replace with AWS S3 in production
- coturn service (docker) placeholder for TURN server (configure secure credentials)
- Twilio OTP integration stub (real Twilio keys required for production)
- S3 presigned upload flow (backend + frontend), fallbacks to local upload
- WebRTC signaling (basic) and notes on TURN/SFU
- GitHub Actions example for CI (deploy to Render) — update secrets in GitHub

## Quick local dev (recommended)
1. Copy `.env.example` to `.env` and adjust variables.
2. Ensure Docker is installed.
3. Build & run:
   ```bash
   docker-compose up --build
   ```
4. Inside the running container (or locally) run DB migration:
   ```bash
   docker exec -it <app_container_name> npm run migrate
   ```
5. Open `http://localhost:3000/public/register.html`

## Production checklist (must do)
- Create AWS S3 bucket and set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_REGION`.
- Create Twilio account and set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`.
- Set `DATABASE_URL` to your managed Postgres (Render, AWS RDS, etc.).
- Set `REDIS_URL` to your Redis instance (not required for small scale but recommended).
- Obtain a VPS/public IP and configure coturn with secure credentials and TLS (or use a managed TURN).
- Configure a domain (`glowchat.com`) and set DNS records for frontend/backend as described in GitHub Actions / hosting instructions.
- Configure GitHub Actions secrets for auto-deploy.

## How S3 presigned uploads work
1. Frontend requests `/api/presign` with filename & contentType.
2. Server returns a presigned PUT URL for S3 (or fallback local upload info).
3. Frontend PUTs the file directly to S3/MinIO using the signed URL.
4. After successful upload, frontend calls the stories API (or server will store record on presign response).

## Twilio OTP
- This scaffold contains Twilio integration. For development, the server returns the OTP in the API response (so you can test easily).
- In production, **do not** return OTP in responses — configure Twilio and remove code that returns OTP.

## TURN / WebRTC
- coturn is included as a docker service placeholder. For production, configure proper `turnserver.conf` and secure user credentials.
- For SFU (group calls) consider LiveKit or mediasoup; instructions are in docs.

## GitHub Actions
- .github/workflows/deploy.yml included as example. Configure secrets and deploy endpoints as per your host (Render / Vercel).

## Next steps I can do for you (pick any)
1. Integrate real Twilio OTP with one-click env injection instructions.
2. Replace MinIO fallback with S3 presigned flow fully wired and tested (requires AWS keys).
3. Create GitHub repository and configure GitHub Actions with secret templates.
4. Setup Render / Vercel deploy configuration and test deployment (requires account access).

---

If you want, I'll now zip this project and give you the download link (it will contain placeholders & instructions).  
Once downloaded, I can also walk you step-by-step to deploy it to Render or a small VPS and connect your domain.
