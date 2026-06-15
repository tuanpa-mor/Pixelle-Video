# Copyright (C) 2025 AIDC-AI
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#     http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""
Settings Page - Debug options
"""

import sys
from pathlib import Path

# Add project root to sys.path
_script_dir = Path(__file__).resolve().parent
_project_root = _script_dir.parent.parent
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

import streamlit as st

from web.state.session import init_session_state, init_i18n
from web.components.header import render_header
from web.i18n import tr

st.set_page_config(
    page_title="Settings - Pixelle-Video",
    page_icon="⚙️",
    layout="wide",
    initial_sidebar_state="collapsed",
)


def main():
    init_session_state()
    init_i18n()
    render_header()

    with st.container(border=True):
        st.markdown(f"**{tr('settings.menu')}**")
        debug_mode = st.toggle(
            tr("settings.debug_mode"),
            value=st.session_state.get("debug_mode", False),
            help=tr("settings.debug_mode_help"),
            key="settings_debug_mode_toggle"
        )
        st.session_state.debug_mode = debug_mode


if __name__ == "__main__":
    main()
