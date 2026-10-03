FROM nginx:alpine
COPY public/ /usr/share/nginx/html/
COPY nginx.conf /etc/nginx/conf.d/default.conf
RUN chmod -R a+rX /usr/share/nginx/html
# Railway injects $PORT; render the nginx config at boot so we listen on it.
CMD ["sh", "-c", ": ${PORT:=8080}; envsubst '$PORT' < /etc/nginx/conf.d/default.conf > /tmp/default.rendered && cp /tmp/default.rendered /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"]
