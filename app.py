from flask import Flask
from database.db import JobDiscoveryDB

from routes.discovery import discovery_bp, init_app as init_discovery
from routes.application import application_bp, init_app as init_application
from routes.interview import interview_bp, init_app as init_interview

app = Flask(__name__)
db = JobDiscoveryDB()

# Initialize blueprints with shared database
init_discovery(db)
init_application(db)
init_interview(db)

app.register_blueprint(discovery_bp)
app.register_blueprint(application_bp)
app.register_blueprint(interview_bp)


if __name__ == "__main__":
    app.run(debug=True, use_reloader=True, port=5000, threaded=True)
