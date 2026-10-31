ARG BUILD_FROM
FROM ${BUILD_FROM}
# Node.js runs the app, ffmpeg gives MKV playback, audio tracks and subtitles
# samba-client: smbclient, for a Time Capsule that only speaks SMB1 (see DOCS)
RUN apk add --no-cache nodejs ffmpeg jq curl samba-client
WORKDIR /app
COPY app/ /app/
COPY run.sh /run.sh
RUN chmod a+x /run.sh
CMD [ "/run.sh" ]
