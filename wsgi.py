import os
import sys

# Ensure the application directory is on sys.path regardless of CWD or WSGI runner environment
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app import app as application  # noqa: F401