#!/bin/bash
cd "$(dirname "$0")"
python3 -m http.server 8080 &
sleep 0.5
open http://localhost:8080
wait
