"""
Arranca todo lo que necesita el dashboard en la Jetson:
  - rosbridge (websocket 9090)      -> datos y comandos
  - web_video_server (puerto 8080)  -> video de las cámaras
  - cámara RGB (USB)                -> /camera/image_raw
  - FLIR Lepton (SPI)               -> /flir/image_raw
  - puente con el ESP32 y lógica de retorno a base

El LiDAR Oradar MS200 se lanza aparte con el launch de su driver (debe publicar /scan).

Uso:  ros2 launch ~/pyxisbot/robot/jetson/robot_minero.launch.py
"""
import os

from launch import LaunchDescription
from launch.actions import ExecuteProcess
from launch_ros.actions import Node


def generate_launch_description():
    aqui = os.path.dirname(os.path.realpath(__file__))
    # Pasarela a la nube (opcional): export CLOUD_URL=https://tu-proyecto.vercel.app CLOUD_KEY=<clave pyx_... del robot, panel → Administración → Robots>
    nube = []
    if os.environ.get('CLOUD_URL') and os.environ.get('CLOUD_KEY'):
        nube = ['--ros-args', '-p', 'cloud_url:=' + os.environ['CLOUD_URL'], '-p', 'cloud_key:=' + os.environ['CLOUD_KEY']]
    return LaunchDescription([
        Node(package='rosbridge_server', executable='rosbridge_websocket',
             name='rosbridge_websocket', parameters=[{'port': 9090}]),
        Node(package='web_video_server', executable='web_video_server',
             name='web_video_server', parameters=[{'port': 8080}]),

        # Cámara RGB por USB. Ajusta /dev/video0 si tu cámara aparece con otro número (ls /dev/video*)
        Node(package='v4l2_camera', executable='v4l2_camera_node', namespace='camera', name='camera',
             parameters=[{'video_device': '/dev/video0', 'image_size': [640, 480]}]),

        ExecuteProcess(cmd=['python3', os.path.join(aqui, 'flir_lepton_node.py')], output='screen'),
        ExecuteProcess(cmd=['python3', os.path.join(aqui, 'jetson_robot_bridge.py')] + nube, output='screen'),
    ])
