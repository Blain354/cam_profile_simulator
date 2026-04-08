from flask import Flask, jsonify
from flask_cors import CORS
import os

app = Flask(__name__)
# Enable CORS so the frontend can communicate with this API
CORS(app)

@app.route('/api/health')
def health():
    return jsonify({
        "status": "online",
        "service": "python-backend",
        "project": os.environ.get('PROJECT_NAME', 'unknown')
    })

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)