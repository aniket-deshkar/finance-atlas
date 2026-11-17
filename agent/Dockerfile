FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py specialists.py assistant.py ./
RUN useradd --system --uid 10001 atlas
USER atlas
CMD ["python", "main.py"]
