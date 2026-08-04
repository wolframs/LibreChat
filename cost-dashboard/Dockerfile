FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py reconcile.py ./
EXPOSE 5000
CMD ["python", "-u", "app.py"]
