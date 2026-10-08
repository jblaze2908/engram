# ntfy for Engram

Optional phone notifications. Put these two files in `/opt/ntfy`, data in `/srv/ntfy` (owned 1601), set `base-url` in
`server.yml` to your hostname and route it to `172.17.0.1:8350`. `upstream-base-url` lets the iOS app get instant
pushes through ntfy.sh's relay (it only sees a hash of the topic and a poll request, never the message).

- Engram publishes to topic `engram` as user `engram` (write-only), with `ENGRAM_NTFY_URL` and `ENGRAM_NTFY_TOKEN` in
  `/etc/engram/engram.env`.
- Your phone subscribes as a read-only user: `docker exec -it ntfy ntfy user add <you>`, then
  `docker exec ntfy ntfy access <you> engram read-only`.
