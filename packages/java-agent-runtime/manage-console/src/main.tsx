import React from "react";
import ReactDOM from "react-dom/client";
import { App as AntApp } from "antd";
import App from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* Ant Design 的全局消息容器必须包住业务根组件，useApp() 才能拿到可调用的 message 实例。 */}
    <AntApp>
      <App />
    </AntApp>
  </React.StrictMode>
);
