import {
  Controller,
  Get,
  UseGuards,
  Req,
  Res,
  Param,
  Query,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Response, Request } from 'express';
import { Issuer, Client } from 'openid-client';

import { OidcService } from './oidc.service';
import { AuthService } from '@builder6/core';

@Controller('api/v6/oidc')
export class OidcController {
  constructor(private readonly oidcService: OidcService, private readonly authService: AuthService) {}

  @Get(':providerId/login')
  async login(@Param('providerId') providerId: string, @Req() req, @Res() res) {
    const provider = await this.oidcService.getProviderFromDB(providerId);
    console.log(provider)
    const issuer = await Issuer.discover(provider.issuer);

    const client = new issuer.Client({
      client_id: provider.client_id,
      client_secret: provider.client_secret,
      redirect_uris: [provider.redirect_uri],
      response_types: ['code'],
    }); // => Client

    const redirectTo = client.authorizationUrl({
      scope: provider.scope,
      state: provider.state,
      nonce: provider.nonce,
      // resource: 'https://my.api.example.com/resource/32178',
      code_challenge: provider.code_challenge,
      code_challenge_method: provider.code_challenge_method,
    });

    req.session[`oidc_${providerId}_state`] = provider.state;
    req.session[`oidc_${providerId}_code_verifier`] = provider.code_verifier;
    req.session[`oidc_${providerId}_nonce`] = provider.nonce;

    return res.redirect(redirectTo);
  }

  @Get(':providerId/login/callback')
  async callback(
    @Param('providerId') providerId: string,
    @Req() req,
    @Res() res,
  ) {
    const storedState = req.session[`oidc_${providerId}_state`];
    const storedVerifier = req.session[`oidc_${providerId}_code_verifier`];
    const storedNonce = req.session[`oidc_${providerId}_nonce`];

    const provider = await this.oidcService.getProviderFromDB(providerId);
    const issuer = await Issuer.discover(provider.issuer);

    const client = new issuer.Client({
      client_id: provider.client_id,
      client_secret: provider.client_secret,
      redirect_uris: [provider.redirect_uri],
      response_types: ['code'],
    }); // => Client

    const params = client.callbackParams(req);

    const tokenSet = await client.callback(provider.redirect_uri, params, {
      state: storedState,
      code_verifier: storedVerifier,
      nonce: storedNonce,
    });
    // console.log('received and validated tokens %j', tokenSet);
    console.log('validated ID Token claims %j', tokenSet.claims());

    delete req.session[`oidc_${providerId}_state`];
    delete req.session[`oidc_${providerId}_code_verifier`];
    delete req.session[`oidc_${providerId}_nonce`];

    const email = tokenSet.claims().email;

    if (email) {
      const userSession = await this.authService.signIn(email);

      const { user, space, auth_token, access_token } = userSession;

      this.authService.setAuthCookies(res, {
        user_id: user,
        space_id: space,
        auth_token,
        access_token,
      });
      
      return res.redirect('/');
    } else {
      return res.status(401).send(tokenSet.claims());
    }

  }
}
