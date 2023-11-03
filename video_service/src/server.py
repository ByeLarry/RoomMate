from flask import Flask, render_template, make_response, Response, request, redirect, url_for, flash, Markup, session
from flask_socketio import SocketIO, emit, join_room, leave_room
from flask_cors import CORS
import json

import config
from db_room_helper import RoomHelper

# import firebase_admin
# from firebase_admin import credentials
# from firebase_admin import firestore


# # # # # # # # # # # # # # # # # # # # 

app = Flask(__name__)
app.config["SECRET_KEY"] = "secret!"

socketio = SocketIO(app)

CORS(app)

db = RoomHelper(config.root_database, config.room_table)

# # # # # # # # # # # # # # # # # # # # 

# cred = credentials.Certificate('roommate-9e1af-120003dd6e68.json')
# default_app = firebase_admin.initialize_app(cred)
# db = firestore.client()

# # # # # # # # # # # # # # # # # # # # 

# region routes

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/login")
def login():
    return render_template("login.html")

@app.route("/sign-up")
def sign_up():
    return render_template("signup.html")

@app.route("/sign-up", methods=["POST"])
def sign_up_post():
    email = request.form.get('email')
    username = request.form.get('username')
    password = request.form.get('password')
    return redirect(url_for('login'))


@app.route("/create-room", methods=["GET", "POST"])
def create_room():
    import uuid
    new_id = uuid.uuid4()
    if request.method == "GET":
        db.add_room(str(new_id))
        return redirect(url_for("room", room_id=str(new_id)))
    
    if request.method == "POST":
        return json.dumps({"id": str(new_id)})

# @app.route("/join-room")
# def join_existing_room():
#     return render_template("room.html")

@app.route("/room")
def room_without_id():
    return render_template("room.404.html")

@app.route("/room/<room_id>")
def room(room_id):
    if not db.room_exists(room_id):
        return render_template("room.404.html")
    return render_template("room.html", room_id=room_id)

@app.route("/rooms")
def get_rooms():
    return Response(json.dumps(db.get_rooms()), mimetype="application/json")

# endregion routes

# # # # # # # # # # # # # # # # # # # # 

# region sockets

@socketio.on("connect")
def on_connect():
    print("New socket connected ", request.sid)
    # socketio.emit("create-room")
    
@socketio.on("join-room")
def on_join_room(room_id, rtcpeer_id):
    join_room(room_id)
    emit("user-connected", {"socket_id": request.sid, "rtc_id":rtcpeer_id}, include_self=False, to=room_id)
    
    @socketio.on("disconnect")
    def on_disconnect():
        print("disconnected ", request.sid)
        emit("user-disconnected", request.sid, include_self=False, to=room_id) 
        
@socketio.on("create-room")
def on_create_room(room_id):
    join_room(room_id)
    

@socketio.on("message")
def on_message(sender, message, room_id):
    socketio.emit("message", {"sender": sender, "text": message}, to=room_id, include_self=True)

@socketio.on("leave-room")
def on_leave_room(room_id, peer_id):
    print(f"{request.sid} left {room_id}")
    
# endregion sockets

# # # # # # # # # # # # # # # # # # # # 


if __name__ == "__main__":
    app.run(debug=True, host='127.0.0.1', port=22334)