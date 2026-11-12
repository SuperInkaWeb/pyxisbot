#!/usr/bin/env python3
"""
FLIR Lepton (conectada por SPI + I2C a la Jetson) -> /flir/image_raw (bgr8, falso color)

Requisitos en la Jetson:
  pip3 install pylepton numpy       (OpenCV viene con JetPack: python3-opencv)
  sudo /opt/nvidia/jetson-io/jetson-io.py   -> activar SPI en los pines 19, 21, 23 y 24 (aparece /dev/spidev0.0)

Parámetros:
  modelo     2 = Lepton 2.x (80x60)   3 = Lepton 3.x (160x120)
  spi_device /dev/spidev0.0
  escala     factor de ampliación de la imagen publicada
  fps        imágenes por segundo (la Lepton entrega unas 8-9)
"""
import cv2
import numpy as np
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import Image


class LeptonNode(Node):
    def __init__(self):
        super().__init__('flir_lepton')
        self.dev = self.declare_parameter('spi_device', '/dev/spidev0.0').value
        modelo = self.declare_parameter('modelo', 3).value
        self.escala = int(self.declare_parameter('escala', 4).value)
        fps = float(self.declare_parameter('fps', 8.0).value)

        self.Lepton = None
        try:
            if modelo == 3:
                from pylepton.Lepton3 import Lepton3 as L
            else:
                from pylepton import Lepton as L
            self.Lepton = L
        except ImportError as e:
            self.get_logger().error(f'Falta pylepton ({e}). Instálalo con: pip3 install pylepton')

        self.pub = self.create_publisher(Image, '/flir/image_raw', 1)
        self.create_timer(1.0 / fps, self.capturar)
        self.get_logger().info(f'FLIR Lepton {modelo}.x en {self.dev}')

    def capturar(self):
        if self.Lepton is None:
            return
        try:
            with self.Lepton(self.dev) as lep:
                datos, _ = lep.capture()
        except Exception as e:
            self.get_logger().error(f'No se pudo leer la Lepton: {e}', throttle_duration_sec=5.0)
            return

        a = np.squeeze(np.asarray(datos)).astype(np.float32)
        lo, hi = np.percentile(a, (1, 99))
        img8 = np.clip((a - lo) / (hi - lo + 1e-6) * 255.0, 0, 255).astype(np.uint8)
        color = cv2.applyColorMap(img8, cv2.COLORMAP_INFERNO)
        if self.escala > 1:
            color = cv2.resize(color, None, fx=self.escala, fy=self.escala, interpolation=cv2.INTER_CUBIC)

        msg = Image()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.header.frame_id = 'flir'
        msg.height, msg.width = color.shape[:2]
        msg.encoding = 'bgr8'
        msg.step = msg.width * 3
        msg.data = color.tobytes()
        self.pub.publish(msg)


def main(args=None):
    rclpy.init(args=args)
    nodo = LeptonNode()
    try:
        rclpy.spin(nodo)
    except KeyboardInterrupt:
        pass
    finally:
        nodo.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
