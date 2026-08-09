#!/usr/bin/env python3
"""Minimal stdlib-only WebSocket client for AutoDL -> Railway boot attestation."""

import argparse
import base64
import hashlib
import json
import os
import select
import socket
import ssl
import struct
import sys
import time
from urllib.parse import urlparse

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def log(message):
    print(time.strftime("%Y-%m-%dT%H:%M:%S%z"), message, flush=True)


def read_exact(sock, length):
    data = bytearray()
    while len(data) < length:
        chunk = sock.recv(length - len(data))
        if not chunk:
            raise ConnectionError("WebSocket connection closed")
        data.extend(chunk)
    return bytes(data)


def read_headers(sock):
    data = bytearray()
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError("Connection closed during WebSocket handshake")
        data.extend(chunk)
        if len(data) > 65536:
            raise ConnectionError("WebSocket handshake headers too large")
    header_bytes, _rest = bytes(data).split(b"\r\n\r\n", 1)
    lines = header_bytes.decode("iso-8859-1").split("\r\n")
    status = lines[0]
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            name, value = line.split(":", 1)
            headers[name.strip().lower()] = value.strip()
    return status, headers


def connect_websocket(url):
    parsed = urlparse(url)
    if parsed.scheme not in ("ws", "wss"):
        raise ValueError("URL must use ws:// or wss://")
    if not parsed.hostname:
        raise ValueError("WebSocket URL has no hostname")

    secure = parsed.scheme == "wss"
    port = parsed.port or (443 if secure else 80)
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query

    raw = socket.create_connection((parsed.hostname, port), timeout=15)
    if secure:
        context = ssl.create_default_context()
        raw = context.wrap_socket(raw, server_hostname=parsed.hostname)

    key = base64.b64encode(os.urandom(16)).decode("ascii")
    host_header = parsed.hostname
    if (secure and port != 443) or (not secure and port != 80):
        host_header = f"{host_header}:{port}"

    request = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host_header}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "User-Agent: autodl-boot-guard/1.0\r\n"
        "\r\n"
    )
    raw.sendall(request.encode("ascii"))

    status, headers = read_headers(raw)
    if " 101 " not in status:
        raw.close()
        raise ConnectionError(f"WebSocket upgrade rejected: {status}")

    expected = base64.b64encode(
        hashlib.sha1((key + WS_GUID).encode("ascii")).digest()
    ).decode("ascii")
    if headers.get("sec-websocket-accept") != expected:
        raw.close()
        raise ConnectionError("Invalid Sec-WebSocket-Accept")

    raw.settimeout(None)
    return raw


def masked_frame(opcode, payload=b""):
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    first = 0x80 | opcode
    length = len(payload)
    mask = os.urandom(4)

    if length < 126:
        header = struct.pack("!BB", first, 0x80 | length)
    elif length <= 0xFFFF:
        header = struct.pack("!BBH", first, 0x80 | 126, length)
    else:
        header = struct.pack("!BBQ", first, 0x80 | 127, length)

    masked = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
    return header + mask + masked


def send_json(sock, value):
    sock.sendall(masked_frame(0x1, json.dumps(value, separators=(",", ":"))))


def send_pong(sock, payload):
    sock.sendall(masked_frame(0xA, payload))


def read_frame(sock):
    first, second = read_exact(sock, 2)
    fin = bool(first & 0x80)
    opcode = first & 0x0F
    masked = bool(second & 0x80)
    length = second & 0x7F

    if not fin:
        raise ConnectionError("Fragmented server frame is not supported")
    if masked:
        raise ConnectionError("Server sent an invalid masked frame")

    if length == 126:
        length = struct.unpack("!H", read_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", read_exact(sock, 8))[0]

    if length > 65536:
        raise ConnectionError("Server frame too large")
    payload = read_exact(sock, length) if length else b""
    return opcode, payload


def run_once(url, token_holder, instance):
    token = token_holder[0]
    sock = connect_websocket(url)
    try:
        send_json(
            sock,
            {
                "type": "boot-attest",
                "instance": instance,
                "token": token,
            },
        )

        sock.settimeout(20)
        opcode, payload = read_frame(sock)
        if opcode == 0x8:
            raise ConnectionError("Server closed during attestation")
        if opcode != 0x1:
            raise ConnectionError("Expected text attestation response")

        response = json.loads(payload.decode("utf-8"))
        if not response.get("ok"):
            raise ConnectionError("Boot attestation was rejected")

        session_token = response.get("sessionToken")
        if isinstance(session_token, str) and session_token:
            token_holder[0] = session_token

        heartbeat_seconds = max(
            5.0, min(30.0, float(response.get("heartbeatMs", 20000)) / 1000.0)
        )
        sock.settimeout(None)
        log("boot attestation accepted")

        while True:
            readable, _, _ = select.select([sock], [], [], heartbeat_seconds)
            if readable:
                opcode, payload = read_frame(sock)
                if opcode == 0x8:
                    raise ConnectionError("Server closed WebSocket")
                if opcode == 0x9:
                    send_pong(sock, payload)
                continue

            send_json(sock, {"type": "heartbeat"})
    finally:
        try:
            sock.close()
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--instance", required=True)
    args = parser.parse_args()

    delay = 3
    token_holder = [args.token]
    while True:
        try:
            run_once(args.url, token_holder, args.instance)
            delay = 3
        except KeyboardInterrupt:
            return 0
        except Exception as exc:
            log(f"connection error: {exc}; retrying in {delay}s")
            time.sleep(delay)
            delay = min(20, delay + 2)


if __name__ == "__main__":
    sys.exit(main())
