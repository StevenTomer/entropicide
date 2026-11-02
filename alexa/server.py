"""The skill (lambda_function.py) as a web service on your own server, as install.sh sets it
up: Apache forwards https://YOUR-SITE/entropicide-alexa here. Each request is checked as
Amazon's (its signature and time, and that it's for ALEXA_SKILL_ID) before it's answered.

  gunicorn --bind 127.0.0.1:5004 server:app
"""
import os

from flask import Flask
from flask_ask_sdk.skill_adapter import SkillAdapter

from lambda_function import sb

# (The skill ID has to be on the builder for requests to be checked against it; SkillAdapter's
# own skill_id isn't enough.)
sb.skill_id = os.environ["ALEXA_SKILL_ID"]
app = Flask(__name__)
SkillAdapter(skill=sb.create(), skill_id=sb.skill_id, app=app).register(app=app, route="/")
