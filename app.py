"""社区夜校 · 大字讲义排版台

所有排版与分页计算都在浏览器端完成（需要读取浏览器真实换行后的
DOM 几何信息）。Flask 只负责提供页面与静态资源。
"""

from flask import Flask, jsonify, render_template

app = Flask(__name__)


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/health")
def health():
    return jsonify(status="ok")


if __name__ == "__main__":
    # 本地直接运行：python app.py
    app.run(host="0.0.0.0", port=8000, debug=False)
