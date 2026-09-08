import React from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "streamdown/styles.css";
import "./styles/globals.css";
import { RouterProvider } from "react-router-dom";

import { AppProviders } from "@/components/layout/app-providers";
import { ClientRootInit } from "@/components/layout/client-root-init";
import "@/i18n";
import { router } from "@/router";
import { AccountGate } from "@/components/account/account-gate";
import { PersistenceNotices } from "@/components/account/persistence-notices";
import { installAccountHttpInterceptors } from "@/services/account-client";
import { installEmbeddedEditorBridge } from "@/services/embedded-editors";
import { installDraftRecoveryGuard } from "@/services/server-storage";

installAccountHttpInterceptors();
installEmbeddedEditorBridge();
installDraftRecoveryGuard();

document.body.style.fontFamily = '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';

createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <AppProviders>
            <AccountGate>
                <ClientRootInit>
                    <RouterProvider router={router} />
                    <PersistenceNotices />
                </ClientRootInit>
            </AccountGate>
        </AppProviders>
    </React.StrictMode>,
);
