#!/bin/bash
export DB_USER=postgres
export DB_PASSWORD=
export DB_HOST=127.0.0.1
cd "$(dirname "$0")"
exec python3 -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
