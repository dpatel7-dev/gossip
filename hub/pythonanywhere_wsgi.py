# Paste these lines into your PythonAnywhere "WSGI configuration file"
# (Web tab -> the link that looks like /var/www/yourname_pythonanywhere_com_wsgi.py),
# replacing everything that's in there. Then press the green Reload button.
#
# It assumes you ran this in a PythonAnywhere Bash console first:
#     git clone https://github.com/dpatel7-dev/gossip.git
import os
import sys

sys.path.insert(0, os.path.expanduser('~/gossip/hub'))
from gossip_hub import application  # noqa: E402,F401
