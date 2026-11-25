FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --require-hashes -r requirements.txt
COPY main.py specialists.py assistant.py runtime.py ./
RUN useradd --system --uid 10001 atlas
USER atlas
CMD ["python", "main.py"]
