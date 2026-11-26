FROM python:3.11-slim

# 容器内不需要中文字体：排版测量发生在老师 / 学员的浏览器里。
WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py ./
COPY templates ./templates
COPY static ./static

EXPOSE 8000

# 社区夜校内网使用，单进程多线程足够；如需正式部署可换多 worker。
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "2", "--threads", "4", "app:app"]
